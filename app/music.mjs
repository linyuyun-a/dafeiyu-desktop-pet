// 网易云音乐：扫码登录 / 搜索 / 取流 / 歌词
// 引擎用现成的 NeteaseCloudMusicApi（它把 weapi/eapi 加密、cookie、登录流程都封好了），这里只做状态与裁剪。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ncm = require('NeteaseCloudMusicApi')
const QRCode = require('qrcode')

const BASE = 'https://music.163.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

let cookieFile = ''
let cookie = ''
let profile = null

export function initMusic(dataDir) {
  cookieFile = path.join(dataDir, 'ncm-cookie.json')
  try {
    const raw = JSON.parse(fs.readFileSync(cookieFile, 'utf8'))
    cookie = String(raw?.cookie || '')
    profile = raw?.profile || null
  } catch {
    cookie = ''
    profile = null
  }
}

function saveCookie() {
  try {
    fs.writeFileSync(cookieFile, JSON.stringify({ cookie, profile }, null, 2), 'utf8')
  } catch (e) {
    console.warn('[music] 存 cookie 失败', e.message)
  }
}

/** NeteaseCloudMusicApi 的调用约定：参数里带 cookie 就用它，返回 {status, body, cookie} */
async function call(name, params = {}) {
  const fn = ncm[name]
  if (typeof fn !== 'function') throw new Error(`NeteaseCloudMusicApi 没有 ${name}`)
  const r = await fn({ ...params, ...(cookie ? { cookie } : {}) })
  return r?.body ?? {}
}

export function hasLogin() {
  return !!cookie
}

export function profileInfo() {
  return profile ? { ...profile } : null
}

// ---------- 扫码登录 ----------

export async function qrKey() {
  const body = await call('login_qr_key', { timestamp: Date.now() })
  const key = body?.data?.unikey
  if (!key) throw new Error('拿不到二维码 key')
  const url = `https://music.163.com/login?codekey=${key}`
  let png = ''
  try {
    png = await QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#0b1520', light: '#e8f3ff' } })
  } catch {}
  return { key, url, png }
}

/** 返回 {code, message}：800 过期 / 801 未扫 / 802 已扫待确认 / 803 成功 */
export async function qrCheck(key) {
  let r
  try {
    r = await ncm.login_qr_check({ key, timestamp: Date.now(), noCookie: true })
  } catch (e) {
    return { code: 800, message: '二维码已过期' }
  }
  const body = r?.body || {}
  const code = Number(body.code || 0)
  if (code === 803) {
    const list = Array.isArray(r?.cookie) ? r.cookie : []
    const kv = list.map((s) => String(s).split(';')[0]).filter(Boolean)
    if (kv.length) {
      cookie = kv.join('; ')
      await refreshProfile()
      saveCookie()
    }
  }
  return { code, message: String(body.message || '') }
}

export async function refreshProfile() {
  if (!cookie) {
    profile = null
    return null
  }
  try {
    const body = await call('login_status')
    const p = body?.data?.profile || body?.profile
    profile = p
      ? {
          nickname: String(p.nickname || ''),
          avatar: String(p.avatarUrl || ''),
          vipType: Number(p.vipType || 0),
          userId: Number(p.userId || 0),
        }
      : null
  } catch {
    profile = null
  }
  return profile
}

export async function logout() {
  try {
    await call('logout')
  } catch {}
  cookie = ''
  profile = null
  saveCookie()
}

// ---------- 搜索 ----------

const FEE_TEXT = { 0: '', 1: 'VIP', 4: '付费专辑', 8: '' }

export async function search(keyword, limit = 12) {
  const kw = String(keyword || '').trim()
  if (!kw) return []
  const body = await call('cloudsearch', { keywords: kw, limit: Math.min(30, Math.max(1, limit)), type: 1 })
  const songs = body?.result?.songs || []
  return songs.map((s) => ({
    id: Number(s.id),
    name: String(s.name || ''),
    artists: (s.ar || s.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
    album: String(s.al?.name || s.album?.name || ''),
    pic: String(s.al?.picUrl || s.album?.picUrl || ''),
    duration: Number(s.dt || s.duration || 0),
    fee: Number(s.fee || 0),
    feeText: FEE_TEXT[Number(s.fee || 0)] || '',
  }))
}

/** 从搜索结果里挑最像“原唱”的一条：歌名/歌手都出现在查询里优先，翻唱伴奏降权 */
export function pickBest(list, keyword) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!list?.length) return null
  // 主人指定了歌手时，先看有没有对得上的；有就只在那一撮里挑（避免「雨爱 杨丞琳」被 DJ 版劫走）
  const hint = kw.replace(/\s+/g, '')
  const artistMatched = list.filter((s) => {
    const ar = String(s.artists || '').toLowerCase().replace(/\s+/g, '')
    if (!ar) return false
    const first = ar.split('/')[0]
    return first.length >= 2 && hint.includes(first) && hint.length - first.length <= 4
  })
  const pool = artistMatched.length ? artistMatched : list
  const score = (s, i) => {
    const name = String(s.name || '').toLowerCase()
    let n = 0
    if (name === kw) n += 60
    else if (name.includes(kw) || kw.includes(name)) n += 30
    const first = String(s.artists || '').split(' / ')[0].toLowerCase()
    // 歌手名要「像人名」才算命中：太短的（比如歌手就叫「起风」）会被「起风了」误伤
    if (first && first.length >= 3 && kw.includes(first) && kw.length - first.length <= 3) n += 40
    if (!/翻唱|伴奏|cover|remix|dj|纯音乐|钢琴版|吉他版|片段/i.test(s.name)) n += 12
    if (s.fee === 0 || s.fee === 1) n += 6
    if (s.duration > 180_000) n += 10
    else if (s.duration > 90_000) n += 4
    else n -= 8
    n += Math.max(0, 8 - i) // 搜索自己的相关度也别全丢
    return n
  }
  return pool.map((s, i) => ({ s, i, v: score(s, i) })).sort((a, b) => b.v - a.v)[0].s
}

// ---------- 取流 ----------

export async function songUrl(id, br = 320000) {
  try {
    const body = await call('song_url', { id, br })
    const d = body?.data?.[0]
    if (d?.url) return { url: String(d.url), br: Number(d.br || 0), size: Number(d.size || 0), trial: false }
  } catch (e) {
    console.warn('[music] song_url 失败', e.message)
  }
  // 兜底：外链（免费曲目可用；VIP 曲目会变成 html）
  return { url: `${BASE}/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`, br: 128000, size: 0, trial: true }
}

export async function lyric(id) {
  const body = await call('lyric', { id })
  return {
    lrc: String(body?.lrc?.lyric || ''),
    yrc: String(body?.yrc?.lyric || ''),
    tlyric: String(body?.tlyric?.lyric || ''),
  }
}

/** 把 LRC 文本解析成 [{t: 毫秒, text}]，跳过空行与元信息 */
export function parseLrc(raw) {
  const out = []
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = line.match(/^\[(\d{1,2}):(\d{1,2}(?:[.:]\d{1,3})?)\](.*)$/)
    if (!m) continue
    const mm = Number(m[1])
    const ss = Number(m[2].replace(':', '.'))
    const text = m[3].trim()
    if (!text) continue
    // 制作名单（「人声录音 : 利伟明」「联合出品：…」这类）不该当歌词显示
    if (/[:：]/.test(text) && text.length <= 40 && /(出品|监制|作词|作曲|编曲|制作|混音|母带|录音|录音室|编辑|统筹|发行|演奏|弦乐|和声|吉他|贝斯|鼓|键盘|OP|SP|词|曲)/.test(text)) continue
    out.push({ t: Math.round((mm * 60 + ss) * 1000), text })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** 给音频转发用的请求头（网易云 CDN 会看 Referer / cookie） */
export function upstreamHeaders() {
  const h = { 'User-Agent': UA, Referer: BASE + '/' }
  if (cookie) h.Cookie = cookie
  return h
}

// ---------- 歌单 ----------

/** 我的歌单：我创建的 + 我收藏的（含「我喜欢的音乐」，specialType 5 排第一） */
export async function playlists(uid) {
  const me = Number(uid || profile?.userId || 0)
  if (!me) throw new Error('还没登录')
  const body = await call('user_playlist', { uid: me, limit: 100, timestamp: Date.now() })
  const list = (body?.playlist || []).map((p) => ({
    id: Number(p.id),
    name: String(p.name || ''),
    trackCount: Number(p.trackCount || 0),
    cover: String(p.coverImgUrl || ''),
    special: Number(p.specialType || 0) === 5,
    creator: String(p.creator?.nickname || ''),
  }))
  list.sort((a, b) => (b.special ? 1 : 0) - (a.special ? 1 : 0) || b.trackCount - a.trackCount)
  return list
}

/** 歌单里的曲目（P3 用，先放这儿省得再改一次模块） */
export async function playlistTracks(id, limit = 500) {
  const body = await call('playlist_track_all', { id: Number(id), limit, offset: 0, timestamp: Date.now() })
  const songs = body?.songs || []
  return songs.map((s) => ({
    id: Number(s.id),
    name: String(s.name || ''),
    artists: (s.ar || []).map((a) => a.name).filter(Boolean).join(' / '),
    album: String(s.al?.name || ''),
    pic: String(s.al?.picUrl || ''),
    duration: Number(s.dt || 0),
    fee: Number(s.fee || 0),
  }))
}
