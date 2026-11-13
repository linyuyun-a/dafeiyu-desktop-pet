"""语音转文字（ASR）适配层：默认 SenseVoice（CPU，够快），备选 Qwen3-ASR-0.6B（GPU，更准）。

为什么是这两个：
- SenseVoice：sherpa-onnx 推理，int8 模型 239MB，不占显存，和常驻 GPU 的 TTS 不打架，
  自带标点（use_itn=True），实测 15.9s 音频 659ms（RTF 0.04）。
- Qwen3-ASR-0.6B：transformers 后端整段转写，5s 音频 ≈1.5s，更准但吃显存；
  真流式只在 vLLM 后端可用（Windows 装 vLLM 代价太大），所以这里也只做整段。

接口：transcribe(pcm_bytes, engine=None) -> {ok, text, ms, dur, engine}
"""

from __future__ import annotations

import os
import threading
import time

SR = 16000

_ENGINES = ("sensevoice", "qwen3")
_STATE = {
    "engine": os.environ.get("PET_ASR_ENGINE", "sensevoice"),
    "ready": False,
    "load_ms": -1,
    "model": "",
    "error": "",
}
_LOCK = threading.Lock()
_IMPL = {}


def default_dir() -> str:
    """模型目录：优先 PET_ASR_DIR，否则应用数据目录下的 asr/。"""
    env = os.environ.get("PET_ASR_DIR", "").strip()
    if env:
        return env
    appdata = os.environ.get("APPDATA", "")
    return os.path.join(appdata, "大肥鱼Live2d桌宠", "asr")


def _sense_dir() -> str:
    return os.path.join(default_dir(), "sensevoice")


def _qwen_dir() -> str:
    env = os.environ.get("PET_QWEN_ASR_DIR", "").strip()
    if env:
        return env
    return os.path.join("D:" + os.sep, "voice-lab", "models", "Qwen3-ASR-0.6B")


def state() -> dict:
    engines = []
    for name in _ENGINES:
        if name == "sensevoice":
            d = _sense_dir()
            ok = os.path.exists(os.path.join(d, "model.int8.onnx")) and os.path.exists(
                os.path.join(d, "tokens.txt")
            )
            engines.append({"name": name, "model": d, "exists": ok})
        else:
            d = _qwen_dir()
            engines.append({"name": name, "model": d, "exists": os.path.isdir(d)})
    return {
        **{k: v for k, v in _STATE.items() if k != "error" or _STATE["error"]},
        "default_dir": default_dir(),
        "engines": engines,
    }


def _load_sensevoice():
    import numpy as np
    import sherpa_onnx

    d = _sense_dir()
    model = os.path.join(d, "model.int8.onnx")
    tokens = os.path.join(d, "tokens.txt")
    if not (os.path.exists(model) and os.path.exists(tokens)):
        raise FileNotFoundError(f"找不到 SenseVoice 模型：{d}")
    rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model, tokens=tokens, num_threads=4, use_itn=True, language="auto"
    )
    return {"np": np, "rec": rec, "desc": "SenseVoice (sherpa-onnx int8, CPU)"}


def _qwen_python() -> str:
    """Qwen3-ASR 需要 transformers 4.57.x：用另一个 venv 的 python 跑独立进程。"""
    env = os.environ.get("PET_ASR_QWEN_PY", "").strip()
    if env:
        return env
    return os.path.join("D:" + os.sep, "voice-lab", "index-tts", ".venv", "Scripts", "python.exe")


def _worker_script() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr_qwen_worker.py")


def _load_qwen3():
    """拉起常驻 worker（模型加载在那边，这里只等它的 ready 行）。"""
    import json
    import struct
    import subprocess

    py = _qwen_python()
    if not os.path.exists(py):
        raise FileNotFoundError(f"找不到 Qwen3-ASR 的解释器：{py}")
    d = _qwen_dir()
    if not os.path.isdir(d):
        raise FileNotFoundError(f"找不到 Qwen3-ASR 模型：{d}")
    proc = subprocess.Popen(
        [py, _worker_script()],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        bufsize=0,
    )
    t0 = time.time()
    line = proc.stdout.readline()
    try:
        info = json.loads(line or b"{}")
    except Exception:
        info = {}
    if not info.get("ready"):
        try:
            proc.kill()
        except Exception:
            pass
        raise RuntimeError(f"Qwen3-ASR 没起来：{line[:120]!r}")
    return {
        "proc": proc,
        "struct": struct,
        "json": json,
        "desc": "Qwen3-ASR-0.6B (transformers fp16, 独立进程)",
        "load_ms": round((time.time() - t0) * 1000),
    }


_LOADERS = {"sensevoice": _load_sensevoice, "qwen3": _load_qwen3}


def _get(engine: str):
    if engine not in _ENGINES:
        raise ValueError(f"未知 ASR 引擎：{engine}")
    if engine in _IMPL:
        return _IMPL[engine]
    t0 = time.time()
    impl = _LOADERS[engine]()
    impl["load_ms"] = round((time.time() - t0) * 1000)
    _IMPL[engine] = impl
    _STATE.update(engine=engine, ready=True, load_ms=impl["load_ms"], model=impl["desc"])
    return impl


def _run_sensevoice(impl, audio, sr):
    st = impl["rec"].create_stream()
    st.accept_waveform(sr, audio)
    impl["rec"].decode_stream(st)
    return (st.result.text or "").strip()


def _run_qwen3(impl, audio, sr):
    """把 float32 音频转回 int16 发给 worker，读一行 JSON 回来。"""
    import numpy as np

    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    proc = impl["proc"]
    proc.stdin.write(impl["struct"].pack("<I", len(pcm)))
    proc.stdin.write(pcm)
    proc.stdin.flush()
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError("Qwen3-ASR worker 断开")
    msg = impl["json"].loads(line.decode("utf-8", "replace"))
    if not msg.get("ok"):
        raise RuntimeError(msg.get("error") or "qwen3 转写失败")
    msg["_ms"] = msg.get("ms")
    return (msg.get("text") or "").strip()


def transcribe_pcm16(pcm: bytes, sample_rate: int = SR, engine: str | None = None) -> dict:
    """pcm: 16bit 小端单声道；返回 {ok, text, ms, dur, engine}。"""
    import numpy as np

    eng = (engine or _STATE["engine"] or "sensevoice").strip()
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    dur = round(len(audio) / float(sample_rate), 2)
    if len(audio) < int(sample_rate * 0.15):
        return {"ok": False, "error": "音频太短", "duration": dur, "engine": eng}
    with _LOCK:
        impl = _get(eng)
        t0 = time.time()
        runner = _run_sensevoice if eng == "sensevoice" else _run_qwen3
        text = runner(impl, audio, sample_rate)
        ms = round((time.time() - t0) * 1000)
    return {"ok": True, "text": text, "ms": ms, "dur": dur, "engine": eng}
