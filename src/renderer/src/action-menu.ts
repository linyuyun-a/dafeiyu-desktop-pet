import type { Live2DSprite } from 'easy-live2d'
import type { Manifest } from './panel'
import type { Action } from './behaviour'
import type { FormId, OutfitId, Wardrobe } from './wardrobe'

/**
 * 右键菜单：把素材里**所有**能演的东西都挂上去。
 *
 * 为什么不自己画 HTML 菜单：
 *   - 原生菜单在 Windows 上是系统绘制，DPI、字体、键盘导航都不用管；
 *   - 透明无边框窗口上画 HTML 菜单要自己处理"点外面关闭"，而点击穿透/拖动都在
 *     同一层 canvas 上抢事件，很容易一菜单点下去把窗口拖走。
 * 代价：主进程要用 `Menu.popup()`，所以菜单结构得序列化过去（见 preload 的 menu）。
 *
 * 菜单是**数据的投影**：manifest 里有多少动作就渲染多少，以后加动作不用改这里。
 */

export interface MenuNode {
  id?: string
  label?: string
  type?: 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  children?: MenuNode[]
}

export interface ActionMenuHost {
  sprite: Live2DSprite
  manifest: Manifest | null
  wardrobe: Wardrobe
  log: (msg: string) => void
  /** 动作统一走 behaviour：它会顺手做"视线让位 + 忙碌标记"，否则转头动作会被 gaze 抹掉 */
  perform: (action: Action) => boolean
  /** 面板想跟着菜单一起收（可选） */
  onOpen?: () => void
  /** 打开对话框（双击会和连点表情打架，入口放这里） */
  onChat?: () => void
}

export interface ActionMenu {
  /** 在鼠标位置弹出，等用户选完再执行 */
  open: () => Promise<void>
  /** 当前会渲染成什么（验收脚本/调试用） */
  spec: () => MenuNode[]
  dispose: () => void
}

export function createActionMenu({ sprite, manifest, wardrobe, log, perform, onOpen, onChat }: ActionMenuHost): ActionMenu {
  const motions = manifest?.motions ?? []
  const expressions = manifest?.expressions ?? []

  /** 组内序号 = 该动作在组里第几个（面板/引擎都按这个下标取 action） */
  const groupIndex = (upto: number): number => {
    const target = motions[upto]
    let n = 0
    for (let i = 0; i < upto; i += 1) if (motions[i].group === target.group) n += 1
    return n
  }

  const buildSpec = (): MenuNode[] => {
    const byGroup = new Map<string, MenuNode[]>()
    motions.forEach((m, index) => {
      const list = byGroup.get(m.group) ?? []
      const dur = m.duration ? `${m.duration.toFixed(2)}s` : ''
      list.push({
        id: `motion:${m.group}:${groupIndex(index)}`,
        label: `${m.label}${dur ? `  ${dur}` : ''}${m.loop ? ' ↻' : ''}`
      })
      byGroup.set(m.group, list)
    })

    const GROUP_LABEL: Record<string, string> = {
      Idle: '待机（原厂循环）',
      TapBody: '抬手（原厂两段开关）',
      Prop: '狗尾草',
      Emote: '竖手指',
      Special: '整段表演（脱捕）',
      Gesture: '手势（自写）',
      TapHead: '被摸头'
    }
    const order = ['Idle', 'TapBody', 'Prop', 'Emote', 'Special', 'Gesture', 'TapHead']
    const groups = [...byGroup.keys()].sort((a, b) => {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })

    const spec: MenuNode[] = [
      { id: 'chat', label: '跟她说话…（Ctrl+单击也行）' },
      { type: 'separator' },
      {
        label: '动作',
        children: [
          { id: 'random-motion', label: '随机来一个' },
          { type: 'separator' },
          ...groups.map((g) => ({ label: GROUP_LABEL[g] ?? g, children: byGroup.get(g) ?? [] }))
        ]
      },
      {
        label: '表情',
        children: [
          { id: 'expr:default', label: '默认（清掉表情）' },
          { id: 'expr-random', label: '随机一个' },
          { type: 'separator' },
          ...expressions.map((e) => ({ id: `expr:${e.id}`, label: e.label }))
        ]
      },
      {
        label: '换装 / 配件',
        children: [
          ...wardrobe.items().map((item) => ({
            id: `outfit:${item.id}`,
            label: item.label,
            type: 'checkbox' as const,
            checked: item.on
          })),
          { type: 'separator' as const },
          { id: 'outfit-reset', label: '全部复位' }
        ]
      },
      {
        label: '形态',
        children: wardrobe.forms().map((f) => ({
          id: `form:${f.id}`,
          label: f.label,
          type: 'checkbox' as const,
          checked: f.active
        }))
      },
      { type: 'separator' },
      { id: 'reset-look', label: '外观全部复位（表情 + 配件 + 形态）' }
    ]
    return spec
  }

  const playMotion = (group: string, no: number): void => {
    // 成对开关组：点任意一段都从"进"开始播完整一对，不然手/道具会停在半路
    if (group === 'TapBody' || group === 'Prop' || group === 'Emote') {
      perform({ type: 'pair', group })
      return
    }
    perform({ type: 'motion', group, no, priority: 3 })
  }

  const run = (id: string): void => {
    if (id === 'chat') {
      onChat?.()
      return
    }
    if (id === 'random-motion') {
      perform({ type: 'any' })
      return
    }
    if (id === 'expr-random') {
      sprite.setRandomExpression()
      log('表情 → 随机')
      return
    }
    if (id === 'outfit-reset') {
      wardrobe.reset()
      log('配件 → 全部复位')
      return
    }
    if (id === 'reset-look') {
      wardrobe.reset()
      sprite.setExpression({ expressionId: 'default' })
      log('外观 → 全部复位')
      return
    }
    if (id.startsWith('motion:')) {
      const [, group, no] = id.split(':')
      playMotion(group, Number(no))
      return
    }
    if (id.startsWith('expr:')) {
      const expressionId = id.slice(5)
      sprite.setExpression({ expressionId })
      log(`表情 → ${expressionId}`)
      return
    }
    if (id.startsWith('outfit:')) {
      const on = wardrobe.toggle(id.slice(7) as OutfitId)
      log(`配件 → ${id.slice(7)} ${on ? '开' : '关'}`)
      return
    }
    if (id.startsWith('form:')) {
      wardrobe.setForm(id.slice(5) as FormId)
      log(`形态 → ${id.slice(5)}`)
    }
  }

  return {
    spec: buildSpec,
    async open() {
      onOpen?.()
      const picked = await window.pet.menu(buildSpec())
      if (picked) run(picked)
    },
    dispose() {}
  }
}
