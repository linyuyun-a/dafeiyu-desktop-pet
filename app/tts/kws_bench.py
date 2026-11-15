"""KWS 基准：只测 CPU 与延迟，不含业务逻辑。

用法：
  python kws_bench.py            # 60 秒静音，看 CPU
  python kws_bench.py <wav>      # 喂一个 wav，看是否命中、命中耗时
"""
import os
import sys
import time
import wave

import numpy as np
import sherpa_onnx

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "kws-models", "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01")
E = os.path.join(MODEL, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
D = os.path.join(MODEL, "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
J = os.path.join(MODEL, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")
T = os.path.join(MODEL, "tokens.txt")
K = os.path.join(HERE, "kws-models", "keywords_zh.txt")


def build(threads=1):
    t0 = time.perf_counter()
    kw = sherpa_onnx.KeywordSpotter(
        tokens=T, encoder=E, decoder=D, joiner=J, keywords_file=K,
        num_threads=threads, sample_rate=16000, feature_dim=80,
        max_active_paths=4, keywords_score=1.0, keywords_threshold=0.25,
        num_trailing_blanks=1, provider="cpu",
    )
    return kw, time.perf_counter() - t0


def feed_silence(kw, seconds=60.0, chunk=1600):
    stream = kw.create_stream()
    n = int(16000 * seconds)
    buf = np.zeros(chunk, dtype=np.float32)
    wall0 = time.perf_counter()
    cpu0 = time.process_time()
    sent = 0
    while sent < n:
        stream.accept_waveform(16000, buf)
        while kw.is_ready(stream):
            kw.decode_stream(stream)
        sent += chunk
    wall = time.perf_counter() - wall0
    cpu = time.process_time() - cpu0
    return wall, cpu


def feed_realtime(kw, seconds=30.0, chunk=1600):
    """按真实节奏喂（每 100ms 喂 0.1s），这才是常驻时的真实占用。"""
    stream = kw.create_stream()
    buf = np.zeros(chunk, dtype=np.float32)
    n = int(16000 * seconds)
    wall0 = time.perf_counter()
    cpu0 = time.process_time()
    sent = 0
    while sent < n:
        stream.accept_waveform(16000, buf)
        while kw.is_ready(stream):
            kw.decode_stream(stream)
        sent += chunk
        time.sleep(0.1)
    wall = time.perf_counter() - wall0
    cpu = time.process_time() - cpu0
    return wall, cpu


def feed_wav(kw, path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000, w.getframerate()
        assert w.getnchannels() == 1, w.getnchannels()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    stream = kw.create_stream()
    t0 = time.perf_counter()
    hit = None
    for i in range(0, len(pcm), 1600):
        stream.accept_waveform(16000, pcm[i:i + 1600])
        while kw.is_ready(stream):
            kw.decode_stream(stream)
        r = kw.get_result(stream)
        if r:
            hit = (r, (time.perf_counter() - t0) * 1000)
            break
    return hit, len(pcm) / 16000.0


if __name__ == "__main__":
    kw, load_ms = build()
    print(f"模型加载 {load_ms*1000:.0f} ms")
    if len(sys.argv) > 1:
        hit, dur = feed_wav(kw, sys.argv[1])
        print(f"音频 {dur:.2f}s → " + (f"命中 {hit[0]} @{hit[1]:.0f}ms" if hit else "未命中"))
    else:
        wall, cpu = feed_silence(kw, 60.0)
        print(f"喂满速 60s：wall {wall:.1f}s cpu {cpu:.2f}s → 处理速度 RTF {cpu/60:.3f}（这段音频只花 {cpu:.2f}s 算力）")
        for _ in range(2):
            wall, cpu = feed_realtime(kw, 30.0)
            print(f"实时 30s：wall {wall:.1f}s cpu {cpu:.2f}s → 单核 {cpu/wall*100:.2f}%")
