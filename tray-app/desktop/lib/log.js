/**
 * 极简文件日志：写 <dataDir>/window.log，超过 1 MB 时滚动成 window.1.log。
 *
 * 浮窗是 detached 进程，没有控制台可看，出问题只能靠这个文件复盘，
 * 所以宁可多写一点：每条都带时间戳。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_BYTES = 1024 * 1024

function stamp() {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  )
}

/**
 * @param {string} file 日志文件绝对路径；目录不存在会自动建。
 * @returns {(message: string) => void}
 */
function createLogger(file) {
  const dir = path.dirname(file)
  let ready = false

  const ensure = () => {
    if (ready) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      const stat = fs.statSync(file, { throwIfNoEntry: false })
      if (stat && stat.size > MAX_BYTES) {
        fs.renameSync(file, path.join(dir, 'window.1.log'))
      }
    } catch {
      /* 日志自己出问题不该把浮窗带崩 */
    }
    ready = true
  }

  return function log(message) {
    ensure()
    const line = `${stamp()} ${message}\n`
    try {
      fs.appendFileSync(file, line, 'utf8')
    } catch {
      /* 同上 */
    }
  }
}

module.exports = { createLogger }
