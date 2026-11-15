# -*- coding: utf-8 -*-
"""大肥鱼 · 本地 TTS 服务（多参考音 / 热切换）

设计要点
--------
自建的一份本地服务，结构是「流式 chunked + 48k PCM 输出 + 首块时间日志」：

    · 多条参考音常驻，请求体里用 `voice` 选；不传就用 index.json 的 default
    · 每条参考音可以带自己的 `instruct` / `temperature`（情绪母带各管各的）
    · 参考音的原文从同名 `.txt` 读（我们生成母带时就知道文本，比转录准）
    · GET  /health         → {ready, voices, default}
    · POST /tts_stream     → {"text": "...", "voice": "angry"} ⇒ audio/L16 流
    · POST /voice/default  → {"voice":"soft"} 切换默认（热切换，不重启）

跑法（建议独立 venv，装 faster-qwen3-tts / sherpa-onnx / soxr / numpy）：

    PET_TTS_MODEL=D:\models\qwen3tts-0.6B python app/tts/server.py
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import asr as asr_mod

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HOST = os.environ.get("PET_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("PET_TTS_PORT", "8769"))
MODEL_DIR = os.environ.get("PET_TTS_MODEL", str(Path(__file__).resolve().parent / "models" / "qwen3tts-0.6B"))
HERE = Path(__file__).resolve().parent
VOICES_DIR = Path(os.environ.get("PET_TTS_VOICES", HERE / "voices"))
OUT_SR = 48000
NATIVE_SR = 24000
CHUNK_SIZE = 12          # 12Hz ⇒ 每块约 1 秒音频

MODEL = None
VOICES: dict[str, dict] = {}
DEFAULT = "soft"
STATE = {"ready": False, "stage": "init"}
_LOCK = threading.Lock()     # 生成串行（GPU 一次一个）


def load_voices() -> None:
    """读 voices/index.json + 每条参考音的 wav/txt。"""
    global DEFAULT
    idx = VOICES_DIR / "index.json"
    if not idx.is_file():
        raise RuntimeError(f"缺少 {idx}")
    cfg = json.loads(idx.read_text(encoding="utf-8"))
    DEFAULT = str(cfg.get("default") or "").strip()
    for name, v in (cfg.get("voices") or {}).items():
        wav = VOICES_DIR / str(v.get("audio") or f"{name}.wav")
        txt = VOICES_DIR / str(v.get("text") or f"{name}.txt")
        if not wav.is_file():
            print(f"  [voices] 跳过 {name}：缺 {wav.name}")
            continue
        ref_text = txt.read_text(encoding="utf-8").strip() if txt.is_file() else ""
        VOICES[name] = {
            "audio": str(wav),
            "text": ref_text,
            "instruct": str(v.get("instruct") or "").strip(),
            "temperature": float(v.get("temperature") or 1.1),
        }
        print(f"  [voices] {name}: {wav.name}  文案 {len(ref_text)} 字  "
              f"instruct={'有' if VOICES[name]['instruct'] else '无'}  "
              f"temp={VOICES[name]['temperature']}")
    if DEFAULT not in VOICES:
        DEFAULT = next(iter(VOICES), "")


def load_model() -> None:
    global MODEL
    STATE["stage"] = "loading"
    import torch
    from faster_qwen3_tts import FasterQwen3TTS

    load_voices()
    print(f"  [engine] 加载 Qwen3-TTS: {MODEL_DIR}")
    if not os.path.isdir(MODEL_DIR):
        print(f"  ✗ 模型目录不存在：{MODEL_DIR}")
        print("    请把 Qwen3-TTS 0.6B 放到 app/tts/models/qwen3tts-0.6B，")
        print("    或在设置→声音→模型目录 / 环境变量 PET_TTS_MODEL 里指向它。")
        raise SystemExit(1)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA 不可用")
    t0 = time.time()
    MODEL = FasterQwen3TTS.from_pretrained(MODEL_DIR, device="cuda", backend="torch", quant="BF16")
    print(f"  [engine] 加载完成 {time.time()-t0:.1f}s")
    STATE["stage"] = "warming"
    t0 = time.time()
    try:
        MODEL.warmup(prefill_len=100)
        print(f"  [engine] 预热完成 {time.time()-t0:.1f}s（CUDA graph）")
    except Exception as exc:
        print(f"  [engine] 预热失败（仍可生成，只是慢些）: {type(exc).__name__}: {str(exc)[:90]}")
    STATE["stage"] = "ready"
    STATE["ready"] = True


def _make_resampler(src_sr: int, dst_sr: int):
    """返回一个「喂一块 float32，吐一块重采样后 float32」的可调用对象。

    优先用 soxr 的流式重采样（带状态、块边界不会断，质量最好）；
    没装就退回 scipy.signal.resample_poly（每条 chunk 独立、边界会有极轻的接缝）。
    """
    try:
        import soxr

        st = soxr.ResampleStream(src_sr, dst_sr, 1, dtype="float32")

        def _f(y):
            return st.resample_chunk(y, last=False)

        return _f
    except Exception:
        import numpy as np
        from scipy.signal import resample_poly

        def _f(y):
            return resample_poly(y, dst_sr // np.gcd(src_sr, dst_sr), src_sr // np.gcd(src_sr, dst_sr)).astype(np.float32)

        return _f


def _kwargs(name: str) -> dict:
    v = VOICES.get(name) or VOICES[DEFAULT]
    kw = {"temperature": v["temperature"]}
    if v["instruct"]:
        kw["instruct"] = v["instruct"]
    if v["text"]:
        kw.update({"ref_audio": v["audio"], "ref_text": v["text"]})
    else:
        kw.update({"ref_audio": v["audio"], "ref_text": "", "xvec_only": True})
    return kw


def synth_stream_pcm(text: str, voice: str):
    """产出 48000Hz / 16bit / mono PCM 块。"""
    import numpy as np
    t0 = time.time()
    first = None
    # 24k -> 48k 必须用带抗镜像滤波的重采样。
    # 原来写的是 np.repeat(y, 2)（最近邻插值），波形变成一级一级的台阶，
    # 高频镜像全叠在 12–24kHz —— 听感就是持续的「滋滋」底噪。
    rs = _make_resampler(24000, OUT_SR)
    with _LOCK:
        for item in MODEL.generate_voice_clone_streaming(
                text, "Chinese", chunk_size=CHUNK_SIZE, **_kwargs(voice)):
            ch = item[0] if isinstance(item, (tuple, list)) else item
            y = np.asarray(ch, np.float32).reshape(-1)
            if y.size == 0:
                continue
            if first is None:
                first = time.time() - t0
                print(f"     首块 {first:.2f}s", flush=True)
            y48 = rs(y)
            if y48.size == 0:
                continue
            yield np.clip(y48, -1.0, 1.0).__mul__(32767.0).astype("<i2").tobytes()
    print(f"     完成 首块 {first if first else -1:.2f}s / 总 {time.time()-t0:.2f}s", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/asr/health"):
            self._json({"ok": True, **asr_mod.state()})
            return
        if self.path.startswith("/health"):
            self._json({"ok": True, "ready": STATE["ready"], "stage": STATE["stage"],
                        "voices": sorted(VOICES), "default": DEFAULT,
                        "model": MODEL_DIR, "sr": OUT_SR, "asr": asr_mod.state()})
            return
        self._json({"ok": False, "error": "not_found"}, 404)

    def _handle_asr(self):
        """裸 PCM 进来（16k / int16 / mono），文本出去。"""
        try:
            n = int(self.headers.get("Content-Length") or 0)
            pcm = self.rfile.read(n) if n > 0 else b""
        except Exception:
            self._json({"ok": False, "error": "bad_body"}, 400)
            return
        if not pcm:
            self._json({"ok": False, "error": "empty_audio"}, 400)
            return
        # ?engine=sensevoice|qwen3 —— 缺省用 asr 模块的默认（PET_ASR_ENGINE 或 sensevoice）
        try:
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(self.path).query)
            engine = (qs.get('engine') or [None])[0]
            out = asr_mod.transcribe_pcm16(pcm, 16000, engine)
        except Exception as exc:
            print(f"  [asr] 失败 {type(exc).__name__}: {exc}", flush=True)
            traceback.print_exc()
            self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
            return
        print(f"  [asr] {out['dur']:.2f}s -> {out['ms']}ms  {out['text'][:40]}", flush=True)
        self._json({"ok": True, **out})

    def do_POST(self):
        global DEFAULT
        if self.path.startswith("/asr"):
            self._handle_asr()
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self._json({"ok": False, "error": "bad_json"}, 400)
            return

        if self.path.startswith("/voice/default"):
            name = str(req.get("voice") or "").strip()
            if name not in VOICES:
                self._json({"ok": False, "error": "unknown_voice", "voices": sorted(VOICES)}, 400)
                return
            DEFAULT = name
            print(f"  [voices] 默认切到 {name}", flush=True)
            self._json({"ok": True, "default": DEFAULT})
            return

        if not self.path.startswith("/tts_stream"):
            self._json({"ok": False, "error": "not_found"}, 404)
            return

        text = str(req.get("text") or "").strip()
        voice = str(req.get("voice") or "").strip() or DEFAULT
        if voice not in VOICES:
            voice = DEFAULT
        if not text:
            self._json({"ok": False, "error": "empty_text"}, 400)
            return
        if not STATE["ready"]:
            self._json({"ok": False, "error": "not_ready", **STATE}, 503)
            return
        print(f"  > 流式合成 {len(text)} 字  voice={voice}", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "audio/L16")
        self.send_header("X-Sample-Rate", str(OUT_SR))
        self.send_header("X-Channels", "1")
        self.send_header("X-Voice", voice)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            total = 0
            for chunk in synth_stream_pcm(text, voice):
                self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                total += len(chunk)
            self.wfile.write(b"0\r\n\r\n")
            print(f"     OK {total/2/OUT_SR:.2f}s 音频", flush=True)
        except BrokenPipeError:
            print("     客户端断开（正常，通常是打断）", flush=True)


def main() -> int:
    print("=" * 80)
    print("  大肥鱼 TTS（多参考音 / 热切换）  http://{}:{}".format(HOST, PORT))
    print("=" * 80)
    try:
        load_model()
    except Exception as exc:
        print(f"  ✗ 加载失败: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        return 1
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"  监听中 … 默认音色 {DEFAULT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
