"""Qwen3-ASR 的独立工作进程（被 app/tts/asr.py 用另一个 venv 的 python 拉起）。

为什么单独起进程：`qwen_asr` 0.0.6 只在 transformers 4.57.x 上能 import，
而 TTS 那边的 venv 里 transformers 更新（import 会直接抛 check_model_inputs 的 TypeError）。
把 ASR 放独立解释器里，两边的依赖互不干扰。

协议（小端）：
  → 4 字节长度 + PCM16(16k mono)
  ← 一行 JSON {"ok":true,"text":"…","ms":123}
启动后先打印一行 {"ready":true,...} 表示模型已加载。
"""

from __future__ import annotations

import json
import os
import struct
import sys
import time

SR = 16000


def default_model_dir() -> str:
    env = os.environ.get("PET_QWEN_ASR_DIR", "").strip()
    if env:
        return env
    return os.path.join("D:" + os.sep, "voice-lab", "models", "Qwen3-ASR-0.6B")


def main() -> int:
    import numpy as np
    from qwen_asr import Qwen3ASRModel

    model_dir = default_model_dir()
    t0 = time.time()
    model = Qwen3ASRModel.from_pretrained(model_dir, max_new_tokens=256, device_map="cuda:0", dtype="float16")
    print(json.dumps({"ready": True, "model": model_dir, "load_ms": round((time.time() - t0) * 1000)}), flush=True)

    stdin = sys.stdin.buffer
    stdout = sys.stdout
    while True:
        head = stdin.read(4)
        if not head or len(head) < 4:
            break
        n = struct.unpack("<I", head)[0]
        pcm = stdin.read(n)
        if len(pcm) < n:
            break
        t0 = time.time()
        try:
            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            out = model.transcribe((audio, SR), language="Chinese")
            text = ((out[0].text if out else "") or "").strip()
            msg = {"ok": True, "text": text, "ms": round((time.time() - t0) * 1000)}
        except Exception as exc:  # 不让单次失败打断常驻进程
            msg = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
        stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
