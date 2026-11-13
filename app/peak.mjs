/**
 * DeepSeek 峰谷时段（北京时间）
 *
 * 官方规则（2026-09-19 说明）：
 *   高峰 = 周一至周五（不含中国法定节假日）的 09:00–12:00、14:00–18:00；
 *   其余时段（含周末、调休上班的周末、法定节假日全天）一律按空闲时段计费。
 *   高峰单价 = 空闲单价 × 2。
 *
 * 这里只做「本机推算」：周末靠 getUTCDay 就能算准，法定节假日需要一张表，
 * 表没覆盖的年份只会把节假日当工作日（多算高峰），不会把工作日算成谷价。
 */

/** 北京时间 0 点起算的高峰区间（小时，左闭右开） */
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

/**
 * 法定节假日（北京时间日期，YYYY-MM-DD）：这些日子全天按谷价。
 * 每年国务院公布次年安排后需要补一次；没列到的年份只会误判成工作日。
 */
export const HOLIDAY_VALLEY = new Set([
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])

const DAY = 86400

/** 把 epoch 秒平移到「北京时间」坐标系（读 UTC 字段即为北京时间） */
function bjDate(sec) {
  return new Date((Number(sec) * 1000) + 8 * 3600 * 1000)
}

/** 该时刻是否高峰 */
export function isPeak(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n)) return false
  const d = bjDate(n)
  const ymd = d.toISOString().slice(0, 10)
  if (HOLIDAY_VALLEY.has(ymd)) return false
  const dow = d.getUTCDay() // 0=周日 6=周六
  if (dow === 0 || dow === 6) return false
  const h = d.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (h >= start && h < end) return true
  }
  return false
}

/**
 * 下一次峰谷切换的时刻（epoch 秒）。
 * 只需要扫北京时间的切换点（0/9/12/14/18 点），扫 12 天足够覆盖最长假期。
 */
export function nextChange(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n)) return null
  const cur = isPeak(n)
  const day0 = Math.floor((n + 8 * 3600) / DAY) * DAY
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * DAY + edge * 3600 - 8 * 3600
      if (cand <= n + 1) continue
      if (isPeak(cand) !== cur) return cand
    }
  }
  return null
}

/** 倒计时：不足一天 HH:MM:SS，超过一天就带上天数 */
export function countdownText(sec) {
  const cand = nextChange(sec)
  if (!cand) return '--:--:--'
  const remain = Math.max(0, cand - Number(sec))
  const p = (v) => String(v).padStart(2, '0')
  const days = Math.floor(remain / 86400)
  const hh = Math.floor((remain % 86400) / 3600)
  const mm = Math.floor((remain % 3600) / 60)
  const ss = remain % 60
  if (days > 0) return `${days}天 ${p(hh)}:${p(mm)}:${p(ss)}`
  return `${p(Math.floor(remain / 3600))}:${p(mm)}:${p(ss)}`
}

/** 面板要用的整行：{peak, label:'峰'|'谷', countdown} */
export function peakLine(sec = Math.floor(Date.now() / 1000)) {
  const peak = isPeak(sec)
  return { peak, label: peak ? '峰' : '谷', countdown: countdownText(sec), next: nextChange(sec) }
}
