"""常驻唤醒词检测（sherpa-onnx KeywordSpotter + sounddevice）。

由主进程 spawn，一行 JSON 一个事件（stdout）：
  {"type":"ready","model":...}
  {"type":"wake","keyword":"大肥鱼","ms":183}
  {"type":"session","on":true}         # 唤醒后进入会话（会一直听你说话）
  {"type":"speech","text":"今天天气怎么样"}   # 一轮你说完、识别完
  {"type":"session_end","why":"timeout"|"bye"|"call_off"}
  {"type":"call","on":true|false}
  {"type":"error","message":"..."}
  {"type":"devices","list":[...]}     # --list-devices 时

stdin 命令（一行一个）：
  pause     暂停检测（她说话时，避免自唤醒）
  resume    恢复
  quit      退出
  call on   进入通话模式（不计静默超时，只有 call off 才退出）
  call off  退出通话模式（回到待机，只听唤醒词）

用法：
  python kws.py --model-dir app/tts/kws-models/<模型目录> --keywords app/tts/kws-models/keywords_zh.txt
"""
import argparse
import json
import os
import sys
import threading
import time

import numpy as np
import sounddevice as sd

SR = 16000
BLOCK = 1600  # 100 ms


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def find_model_files(d):
    def pick(prefix):
        for n in sorted(os.listdir(d)):
            if n.startswith(prefix) and n.endswith(".int8.onnx"):
                return os.path.join(d, n)
        for n in sorted(os.listdir(d)):
            if n.startswith(prefix) and n.endswith(".onnx"):
                return os.path.join(d, n)
        raise SystemExit(f"模型目录里没找到 {prefix}*.onnx：{d}")

    return {
        "tokens": os.path.join(d, "tokens.txt"),
        "encoder": pick("encoder"),
        "decoder": pick("decoder"),
        "joiner": pick("joiner"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=False, default="")
    ap.add_argument("--keywords", default="")
    ap.add_argument("--device", default="")       # 序号或名字片段
    ap.add_argument("--threshold", type=float, default=0.25)
    ap.add_argument("--score", type=float, default=1.0)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--idle", type=float, default=10.0)   # 会话静默多少秒结束
    ap.add_argument("--list-devices", action="store_true")
    args = ap.parse_args()

    if args.list_devices:
        out = []
        for i, d in enumerate(sd.query_devices()):
            if d.get("max_input_channels", 0) > 0:
                out.append({"id": i, "name": d["name"], "channels": d["max_input_channels"],
                            "default": i == sd.default.device[0]})
        emit({"type": "devices", "list": out})
        return

    import sherpa_onnx

    files = find_model_files(args.model_dir)
    kw = sherpa_onnx.KeywordSpotter(
        tokens=files["tokens"],
        encoder=files["encoder"],
        decoder=files["decoder"],
        joiner=files["joiner"],
        keywords_file=args.keywords,
        num_threads=args.threads,
        sample_rate=SR,
        feature_dim=80,
        max_active_paths=4,
        keywords_score=args.score,
        keywords_threshold=args.threshold,
        num_trailing_blanks=1,
        provider="cpu",
    )

    # ---- ASR（用于会话里的每句话）----
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    asr_mod = None
    try:
        import asr as asr_mod  # noqa: N813
        st = asr_mod.state()
        ok_engine = next((e for e in st.get("engines", []) if e.get("name") == "sensevoice"), None)
        if not (ok_engine and ok_engine.get("exists")):
            asr_mod = None
    except Exception:
        asr_mod = None

    # ---- 会话状态机 ----
    # idle   : 只听唤醒词
    # session: 唤醒后一直听，静默 idle 秒后结束
    # call   : 通话，静默不结束，只有 call off 才退出
    S = {
        "mode": "idle",
        "paused": False,
        "running": True,
        "last_voice": 0.0,
        "last_text": 0.0,
        "loud_run": 0,
        "voiced": False,
        "buf": [],             # 当前这一句的音频块
        "silence": 0.0,        # 句尾静音累计
        "idle_sec": args.idle,
    }
    BYE = ("再见", "拜拜", "没事了", "不用了", "先这样", "不聊了", "退下", "结束吧")

    def rms(block):
        return float(np.sqrt(np.mean(np.square(block)) + 1e-12))

    def flush_speech():
        """把缓冲的一段话送去识别，成功后 emit speech。"""
        if not S["buf"]:
            return
        audio = np.concatenate(S["buf"]).astype(np.float32)
        S["buf"] = []
        if audio.shape[0] < SR * 0.25:  # 太短，当做咳嗽/关门
            return
        if asr_mod is None:
            emit({"type": "speech", "text": "", "error": "no-asr"})
            return
        pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes()
        try:
            r = asr_mod.transcribe(pcm, "sensevoice")
        except Exception as e:
            emit({"type": "speech", "text": "", "error": str(e)})
            return
        text = (r.get("text") or "").strip()
        emit({"type": "speech", "text": text, "ms": r.get("ms"), "dur": r.get("dur")})
        if text and any(b in text for b in BYE):
            end_session("bye")

    def end_session(why):
        if S["mode"] != "session":
            return
        S["mode"] = "idle"
        S["buf"] = []
        S["voiced"] = False
        S["loud_run"] = 0
        S["last_text"] = 0.0
        emit({"type": "session_end", "why": why})

    state = {"paused": False, "running": True}

    def reader():
        for line in sys.stdin:
            cmd = line.strip().lower()
            if cmd == "pause":
                state["paused"] = True
            elif cmd == "resume":
                state["paused"] = False
            elif cmd == "call on":
                S["mode"] = "call"
                S["last_voice"] = time.time()
                emit({"type": "call", "on": True})
            elif cmd == "call off":
                if S["mode"] == "call":
                    S["mode"] = "session"
                    S["last_voice"] = time.time()
                    S["last_text"] = time.time()
                    emit({"type": "call", "on": False})
            elif cmd == "fake":
                # 测试用：不靠麦克风，直接把状态推到「会话开始」
                S["mode"] = "session"
                S["buf"] = []
                S["voiced"] = False
                S["silence"] = 0.0
                S["last_voice"] = time.time()
                S["last_text"] = time.time()
                S["loud_run"] = 0
                emit({"type": "session", "on": True})
                print(f"[kws] fake wake, idle={S['idle_sec']}", file=sys.stderr, flush=True)
            elif cmd == "quit":
                state["running"] = False
                return

    threading.Thread(target=reader, daemon=True).start()

    device = None
    if args.device:
        if args.device.isdigit():
            device = int(args.device)
        else:
            for i, d in enumerate(sd.query_devices()):
                if args.device.lower() in d["name"].lower() and d.get("max_input_channels", 0) > 0:
                    device = i
                    break

    emit({"type": "ready", "model": args.model_dir, "device": device, "idle": S["idle_sec"]})

    def maybe_timeout():
        """会话超时：只看最后一次识别出真实文本的时间（噪声不会刷新它）。"""
        if S["mode"] != "session":
            return
        d = time.time() - S["last_text"]
        if d > S["idle_sec"]:
            print(f"[kws] timeout d_text={d:.1f} idle={S['idle_sec']}", file=sys.stderr, flush=True)
            end_session("timeout")

    stream = kw.create_stream()

    # 用回调模式而不是 s.read()：某些设备（VB-Cable / WDM-KS）不支持阻塞读，
    # 会报 "Blocking API not supported yet"。回调 + 队列对两种设备都成立。
    import queue
    q = queue.Queue(maxsize=64)

    def _cb(indata, frames, time_info, status):  # noqa: ARG001
        try:
            q.put_nowait(indata.copy())
        except queue.Full:
            pass

    try:
        with sd.InputStream(channels=1, dtype="float32", samplerate=SR, blocksize=BLOCK,
                            device=device, callback=_cb) as s:
            while state["running"]:
                try:
                    data = q.get(timeout=0.5)
                except queue.Empty:
                    maybe_timeout()
                    continue
                if state["paused"]:
                    # 暂停期间把积压的块丢掉，避免恢复时把旧音频当成新声音
                    while not q.empty():
                        try: q.get_nowait()
                        except queue.Empty: break
                    continue

                if S["mode"] in ("session", "call"):
                    # 会话：只做 VAD + 攒这句音频，不再跑唤醒词
                    blk = data.reshape(-1)
                    lv = rms(blk) > 0.02
                    S["loud_run"] = (S["loud_run"] + 1) if lv else 0
                    loud = lv and (S["loud_run"] >= 2 or S["buf"])
                    now = time.time()
                    if loud:
                        S["voiced"] = True
                        S["silence"] = 0.0
                        S["last_voice"] = now
                        S["buf"].append(blk.copy())
                    else:
                        if S["voiced"]:
                            S["buf"].append(blk.copy())
                            S["silence"] += len(blk) / SR
                            if S["silence"] >= 0.7:     # 说完 0.7s → 出一句
                                S["voiced"] = False
                                S["silence"] = 0.0
                                flush_speech()
                                S["last_voice"] = now
                    maybe_timeout()
                    continue

                stream.accept_waveform(SR, data.reshape(-1))
                while kw.is_ready(stream):
                    kw.decode_stream(stream)
                    r = kw.get_result(stream)
                    if r:
                        # r 是命中的关键词（token 串或 @后面的原文），统一取最后一段
                        word = str(r).split("@")[-1].strip()
                        emit({"type": "wake", "keyword": word})
                        kw.reset_stream(stream)
                        # 唤醒即进入会话：从现在开始只听你说话
                        S["mode"] = "session"
                        S["buf"] = []
                        S["voiced"] = False
                        S["silence"] = 0.0
                        S["last_voice"] = time.time()
                        S["last_text"] = time.time()
                        S["loud_run"] = 0
                        emit({"type": "session", "on": True})
    except Exception as e:  # 麦克风打不开、设备被占用…
        emit({"type": "error", "message": str(e)})
        raise SystemExit(1)


if __name__ == "__main__":
    main()
