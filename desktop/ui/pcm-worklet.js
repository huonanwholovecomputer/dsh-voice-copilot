// 小印浮窗 · 采音 worklet
// 注意：worklet 文件里不能出现 ESM 的 import / export，只能 registerProcessor。
// 每个渲染量子（128 帧）把单声道 Float32 拷一份 postMessage 给渲染线程。

class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const first = input[0]
    if (!first || first.length === 0) return true

    let mono
    if (input.length === 1) {
      // 单声道直接拷一份（拷贝后才能安全 transfer）
      mono = new Float32Array(first)
    } else {
      // 多声道下混成单声道
      mono = new Float32Array(first.length)
      for (let ch = 0; ch < input.length; ch += 1) {
        const data = input[ch]
        if (!data) continue
        for (let i = 0; i < mono.length; i += 1) mono[i] += data[i]
      }
      const scale = 1 / input.length
      for (let i = 0; i < mono.length; i += 1) mono[i] *= scale
    }

    // 输出保持静音，避免把麦克风回放出来
    const out = outputs[0]
    if (out) {
      for (let ch = 0; ch < out.length; ch += 1) out[ch].fill(0)
    }

    this.port.postMessage(mono, [mono.buffer])
    return true
  }
}

registerProcessor('pcm-tap', PcmTapProcessor)
