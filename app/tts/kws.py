"""常驻唤醒词检测（sherpa-onnx KeywordSpotter + sounddevice）。

由主进程 spawn，一行 JSON 一个事件（stdout）：
  {"type":"ready","model":...}
  {"type":"wake","keyword":"大肥鱼","ms":183}
  {"type":"error","message":"..."}
  {"type":"devices","list":[...]}     # --list-devices 时

stdin 命令（一行一个）：
  pause     暂停检测（她说话时，避免自唤醒）
  resume    恢复
  quit      退出

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

    state = {"paused": False, "running": True}

    def reader():
        for line in sys.stdin:
            cmd = line.strip().lower()
            if cmd == "pause":
                state["paused"] = True
            elif cmd == "resume":
                state["paused"] = False
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

    emit({"type": "ready", "model": args.model_dir, "device": device})

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
                    continue
                if state["paused"]:
                    # 暂停期间把积压的块丢掉，避免恢复时把旧音频当成新声音
                    while not q.empty():
                        try: q.get_nowait()
                        except queue.Empty: break
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
    except Exception as e:  # 麦克风打不开、设备被占用…
        emit({"type": "error", "message": str(e)})
        raise SystemExit(1)


if __name__ == "__main__":
    main()
