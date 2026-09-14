/**
 * 正交布线器：给「已定坐标」的图算出让 archify 校验通过的走线。
 *
 * ## 为什么需要它
 *
 * archify 对连线有一条硬校验 `clean-flow/edge-through-node`：**连线不得穿过与它无关的节点**
 * （默认 2px 净空）。它的自动布线在「节点多、边多、网格小」时经常做不到 —— 实测：
 * - `lifecycle` 的任务状态机 36 条转移，自动布线几乎全部穿节点；
 * - `architecture` 同列相邻模块之间同理。
 * archify 的报错提示也很直白：`set route/via or channelX/channelY, or move the component`。
 *
 * 而 `channelY` / `channelX` **不是**避让指令（实测：命名通道照样穿节点），
 * 真正可行的是自己给出 `via` 路径点。这就是本模块存在的原因。
 *
 * 附带一个官方豁免：给 `via` 之后，`clean-flow/endpoint-side-direction` 会被跳过
 * （`render-lifecycle.mjs` 里写作 `shouldCheckRelation: !Array.isArray(via)`）。
 * 但本模块**仍然**按侧向契约布线（从 `fromSide` 垂直离开、垂直进入 `toSide`），
 * 一来线更好看，二来换个渲染器也不会突然被拒。
 *
 * ## 算法：Hanan 网格 + Dijkstra（折点优先）
 *
 * 1. **建轴**：把所有障碍矩形的外扩边、空白走廊、两端点的进出点与「短桩点」投影到
 *    x/y 轴上，得到一组候选线（Hanan 网格）。
 * 2. **定桩**：从 `fromSide` 的中点沿法向外推 `stub`（默认 16px）得到 `outA`，
 *    同法从 `toSide` 得到 `inB`。短桩保证「垂直穿越节点边界」这一视觉契约，
 *    也把起点/终点挪出障碍的外扩盒。
 * 3. **搜索**：在网格上跑 Dijkstra，移动代价 = 线段长度 + 每次拐弯一个 `BEND_SCALE`
 *    量级的大数 —— 即**字典序**地先比拐点数、再比总长（archify 的审美偏好）。
 *    被外扩盒挡住的原子段直接不可通行。
 * 4. **择优**：对 16 种「出口侧 × 入口侧」各跑一次，按
 *    （是否满足 `minSegment` → 拐点数 → 总长 → 侧序）取最优；全不满足 `minSegment`
 *    时也退回可通行的那条（**能画出来 > 画得漂亮**，只是留一条短折线）。
 * 5. **无解**：返回 `null`，调用方应当**丢弃该边**而不是产出非法 IR。
 *
 * 全程纯几何：零 IO / 零时钟 / 零随机，同输入必同输出。
 *
 * ## 与 archify 的一点契约细节
 *
 * `RoutePlan.via` 只含**中间**折点，**不含**两端锚点 —— 与 archify 自己生成候选时
 * 的 `.slice(1, -1)` 一致。渲染器会自行补上 `anchor(box, side)` 作为首末点，
 * 那个公式与本模块的 `port()` 完全相同，所以不会错位。
 */

/** 节点矩形（世界坐标）。 */
export interface RouterBox {
  x0: number
  x1: number
  y0: number
  y1: number
}

export type RouterSide = 'top' | 'right' | 'bottom' | 'left'

export interface RoutePlan {
  fromSide: RouterSide
  toSide: RouterSide
  route: 'straight'
  /** 路径的**中间**折点（不含两端锚点），直接喂给 archify 的 `via` */
  via: Array<[number, number]>
}

export interface RouterOptions {
  /** 纵向走廊 x（升序）；留空则只靠节点自身的投影线 */
  corridors?: readonly number[]
  /** 横向通道 y（升序） */
  channels?: readonly number[]
  /** 与节点保持的净空（archify 默认 2px；这里留 6px 更稳） */
  clearance?: number
  /**
   * 每段的最短长度。archify 对**作者提供 `via`** 的连线没有逐段下限
   * （只有「两端锚点距离 ≥ 32px」这条整体约束，且那由布局决定、布线无法补救），
   * 所以这里取 12 只是为了挡住「发丝级折线」这类肉眼噪声，不是渲染器要求。
   */
  minSegment?: number
  /** 端点短桩长度：保证连线垂直离开/进入节点边界。 */
  stub?: number
}

/** 16 种「出口 × 入口」组合的稳定遍历顺序（决定并列时的取舍）。 */
const SIDES: readonly RouterSide[] = ['right', 'left', 'bottom', 'top']

const OUTWARD: Readonly<Record<RouterSide, readonly [number, number]>> = {
  top: [0, -1],
  right: [1, 0],
  bottom: [0, 1],
  left: [-1, 0],
}

/** 4 个移动方向：+x / -x / +y / -y。 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/**
 * 折点相对长度的权重：取一个远大于任何可能路径长度的大数，
 * 使 `cost = bends * BEND_SCALE + length` 成为**严格的字典序**（先折点、后长度）。
 */
const BEND_SCALE = 1_000_000

const DEFAULT_CLEARANCE = 6
const DEFAULT_MIN_SEGMENT = 12
const DEFAULT_STUB = 16

interface Point {
  x: number
  y: number
}

function port(box: RouterBox, side: RouterSide): Point {
  switch (side) {
    case 'top':
      return { x: (box.x0 + box.x1) / 2, y: box.y0 }
    case 'bottom':
      return { x: (box.x0 + box.x1) / 2, y: box.y1 }
    case 'left':
      return { x: box.x0, y: (box.y0 + box.y1) / 2 }
    case 'right':
      return { x: box.x1, y: (box.y0 + box.y1) / 2 }
  }
}

function inflate(box: RouterBox, by: number): RouterBox {
  return { x0: box.x0 - by, x1: box.x1 + by, y0: box.y0 - by, y1: box.y1 + by }
}

function strictlyInside(box: RouterBox, point: Point): boolean {
  return point.x > box.x0 && point.x < box.x1 && point.y > box.y0 && point.y < box.y1
}

/** 轴对齐线段是否穿过矩形内部（端点贴边不算；非正交线段一律视为穿过）。 */
function segmentHitsBox(a: Point, b: Point, box: RouterBox): boolean {
  if (Math.abs(a.y - b.y) < 1e-6) {
    if (!(a.y > box.y0 && a.y < box.y1)) return false
    const lo = Math.min(a.x, b.x)
    const hi = Math.max(a.x, b.x)
    return hi > box.x0 && lo < box.x1
  }
  if (Math.abs(a.x - b.x) < 1e-6) {
    if (!(a.x > box.x0 && a.x < box.x1)) return false
    const lo = Math.min(a.y, b.y)
    const hi = Math.max(a.y, b.y)
    return hi > box.y0 && lo < box.y1
  }
  return true
}

/** 去掉重复点与共线中间点（保留首末点）。 */
function simplify(points: readonly Point[]): Point[] {
  const deduped: Point[] = []
  for (const point of points) {
    const last = deduped[deduped.length - 1]
    if (last !== undefined && Math.abs(last.x - point.x) < 1e-6 && Math.abs(last.y - point.y) < 1e-6) continue
    deduped.push(point)
  }
  const out: Point[] = []
  for (const point of deduped) {
    while (out.length >= 2) {
      const a = out[out.length - 2]!
      const b = out[out.length - 1]!
      const collinear =
        (Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - point.x) < 1e-6) ||
        (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - point.y) < 1e-6)
      if (!collinear) break
      out.pop()
    }
    out.push(point)
  }
  return out
}

function pathLength(points: readonly Point[]): number {
  let total = 0
  for (let i = 0; i + 1 < points.length; i++) {
    total += Math.abs(points[i]!.x - points[i + 1]!.x) + Math.abs(points[i]!.y - points[i + 1]!.y)
  }
  return total
}

function pathMinSegment(points: readonly Point[]): number {
  let min = Infinity
  for (let i = 0; i + 1 < points.length; i++) {
    min = Math.min(min, Math.abs(points[i]!.x - points[i + 1]!.x) + Math.abs(points[i]!.y - points[i + 1]!.y))
  }
  return min
}

/** 极简二叉堆（只在 Dijkstra 内部用，元素是 `[cost, state]`）。 */
class MinHeap {
  private readonly costs: number[] = []
  private readonly states: number[] = []

  get size(): number {
    return this.costs.length
  }

  push(cost: number, state: number): void {
    this.costs.push(cost)
    this.states.push(state)
    let index = this.costs.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (this.costs[parent]! <= this.costs[index]!) break
      this.swap(parent, index)
      index = parent
    }
  }

  pop(): { cost: number; state: number } {
    const cost = this.costs[0]!
    const state = this.states[0]!
    const lastCost = this.costs.pop()!
    const lastState = this.states.pop()!
    if (this.costs.length > 0) {
      this.costs[0] = lastCost
      this.states[0] = lastState
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < this.costs.length && this.costs[left]! < this.costs[smallest]!) smallest = left
        if (right < this.costs.length && this.costs[right]! < this.costs[smallest]!) smallest = right
        if (smallest === index) break
        this.swap(smallest, index)
        index = smallest
      }
    }
    return { cost, state }
  }

  private swap(a: number, b: number): void {
    const cost = this.costs[a]!
    this.costs[a] = this.costs[b]!
    this.costs[b] = cost
    const state = this.states[a]!
    this.states[a] = this.states[b]!
    this.states[b] = state
  }
}

interface Grid {
  nx: number
  ny: number
  xAt: (i: number) => number
  yAt: (j: number) => number
  /** 水平原子段 `(i,j) → (i+1,j)` 是否被挡 */
  hBlocked: Uint8Array
  /** 垂直原子段 `(i,j) → (i,j+1)` 是否被挡 */
  vBlocked: Uint8Array
}

/**
 * 按障碍外扩边 + 走廊通道 + `extras` 建 Hanan 网格，并预计算各原子段是否可通行。
 *
 * 预计算的意义：把「撞不撞盒子」的 O(障碍数) 判定压成 O(1) 查表，
 * 于是每个 (出口侧 × 入口侧) 组合上跑一次 Dijkstra 的代价可以忽略。
 */
function buildGrid(obstacles: readonly RouterBox[], extras: readonly Point[], options: RouterOptions): Grid {
  const clearance = options.clearance ?? DEFAULT_CLEARANCE
  const xSet = new Set<number>()
  const ySet = new Set<number>()
  for (const box of obstacles) {
    const grown = inflate(box, clearance)
    xSet.add(grown.x0)
    xSet.add(grown.x1)
    ySet.add(grown.y0)
    ySet.add(grown.y1)
  }
  for (const x of options.corridors ?? []) xSet.add(x)
  for (const y of options.channels ?? []) ySet.add(y)
  for (const point of extras) {
    xSet.add(point.x)
    ySet.add(point.y)
  }

  const xs = [...xSet].sort((a, b) => a - b)
  const ys = [...ySet].sort((a, b) => a - b)
  const nx = xs.length
  const ny = ys.length

  const grown = obstacles.map((box) => inflate(box, clearance))
  const hBlocked = new Uint8Array(Math.max(0, nx - 1) * ny)
  const vBlocked = new Uint8Array(nx * Math.max(0, ny - 1))
  for (let j = 0; j < ny; j++) {
    const y = ys[j]!
    for (let i = 0; i + 1 < nx; i++) {
      const x0 = xs[i]!
      const x1 = xs[i + 1]!
      for (const box of grown) {
        if (y > box.y0 && y < box.y1 && x1 > box.x0 && x0 < box.x1) {
          hBlocked[j * (nx - 1) + i] = 1
          break
        }
      }
    }
  }
  for (let i = 0; i < nx; i++) {
    const x = xs[i]!
    for (let j = 0; j + 1 < ny; j++) {
      const y0 = ys[j]!
      const y1 = ys[j + 1]!
      for (const box of grown) {
        if (x > box.x0 && x < box.x1 && y1 > box.y0 && y0 < box.y1) {
          vBlocked[j * nx + i] = 1
          break
        }
      }
    }
  }

  return {
    nx,
    ny,
    xAt: (i) => xs[i]!,
    yAt: (j) => ys[j]!,
    hBlocked,
    vBlocked,
  }
}

/** 网格上从 `start` 到 `end` 的最短正交路径（折点优先）。无解返回 null。 */
function search(grid: Grid, start: Point, end: Point): Point[] | null {
  const { nx, ny, hBlocked, vBlocked } = grid
  const xIndex = new Map<number, number>()
  const yIndex = new Map<number, number>()
  for (let i = 0; i < nx; i++) xIndex.set(grid.xAt(i), i)
  for (let j = 0; j < ny; j++) yIndex.set(grid.yAt(j), j)
  const si = xIndex.get(start.x)
  const sj = yIndex.get(start.y)
  const ei = xIndex.get(end.x)
  const ej = yIndex.get(end.y)
  if (si === undefined || sj === undefined || ei === undefined || ej === undefined) return null

  const cells = nx * ny
  const total = cells * DIRS.length
  const best = new Float64Array(total).fill(Infinity)
  const prev = new Int32Array(total).fill(-1)
  const heap = new MinHeap()

  // 起点：4 个方向都以零代价入场（第一次移动不算拐弯）
  for (let d = 0; d < DIRS.length; d++) {
    const state = (sj * nx + si) * DIRS.length + d
    best[state] = 0
    heap.push(0, state)
  }

  const goalBase = (ej * nx + ei) * DIRS.length
  while (heap.size > 0) {
    const { cost, state } = heap.pop()
    if (cost > best[state]! + 1e-9) continue
    if (state >= goalBase && state < goalBase + DIRS.length) break
    const d = state % DIRS.length
    const cell = (state - d) / DIRS.length
    const i = cell % nx
    const j = (cell - i) / nx
    for (let nd = 0; nd < DIRS.length; nd++) {
      const [dxStep, dyStep] = DIRS[nd]!
      const ni = i + dxStep
      const nj = j + dyStep
      if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue
      const span = dxStep !== 0 ? Math.abs(grid.xAt(ni) - grid.xAt(i)) : Math.abs(grid.yAt(nj) - grid.yAt(j))
      if (span < 1e-9) continue
      if (dxStep !== 0) {
        const low = Math.min(i, ni)
        if (hBlocked[j * (nx - 1) + low] === 1) continue
      } else {
        const low = Math.min(j, nj)
        if (vBlocked[low * nx + i] === 1) continue
      }
      const nextState = (nj * nx + ni) * DIRS.length + nd
      const nextCost = cost + span + (nd === d ? 0 : BEND_SCALE)
      if (nextCost >= best[nextState]!) continue
      best[nextState] = nextCost
      prev[nextState] = state
      heap.push(nextCost, nextState)
    }
  }

  let bestGoal = -1
  let bestCost = Infinity
  for (let d = 0; d < DIRS.length; d++) {
    const state = goalBase + d
    if (best[state]! < bestCost) {
      bestCost = best[state]!
      bestGoal = state
    }
  }
  if (bestGoal < 0) return null

  const points: Point[] = []
  for (let state = bestGoal; state >= 0; state = prev[state]!) {
    const d = state % DIRS.length
    const cell = (state - d) / DIRS.length
    const i = cell % nx
    const j = (cell - i) / nx
    points.push({ x: grid.xAt(i), y: grid.yAt(j) })
  }
  points.reverse()
  return points
}

/**
 * 规划一条 `from → to` 的正交走线。
 *
 * @param obstacles 全部节点矩形（含 `from` / `to` 自身；内部会把这两者排除出障碍）
 * @returns 最优可用方案；**无解时返回 `null`**（调用方应当跳过该边而不是产出非法 IR）
 */
export function planRoute(
  from: RouterBox,
  to: RouterBox,
  obstacles: readonly RouterBox[],
  options: RouterOptions = {},
): RoutePlan | null {
  const stub = options.stub ?? DEFAULT_STUB
  const minSegment = options.minSegment ?? DEFAULT_MIN_SEGMENT

  // 只避让「无关」节点：两端自身的盒子不能算障碍（否则出口段必然相撞）
  const others = obstacles.filter((box) => box !== from && box !== to)
  const grown = others.map((box) => inflate(box, options.clearance ?? DEFAULT_CLEARANCE))

  // 网格里必须包含「进出点」与「短桩点」，否则 search 找不到起终点
  const extras: Point[] = []
  for (const box of [from, to]) {
    for (const side of SIDES) {
      const anchor = port(box, side)
      const [dx, dy] = OUTWARD[side]
      extras.push(anchor)
      extras.push({ x: anchor.x + dx * stub, y: anchor.y + dy * stub })
    }
  }
  const grid = buildGrid(others, extras, options)

  interface Candidate {
    fromSide: RouterSide
    toSide: RouterSide
    via: Array<[number, number]>
    corners: number
    length: number
    ok: boolean
    order: number
  }
  const choices: Candidate[] = []

  for (let fromIndex = 0; fromIndex < SIDES.length; fromIndex += 1) {
    const fromSide = SIDES[fromIndex]!
    const [ax, ay] = OUTWARD[fromSide]
    const startAnchor = port(from, fromSide)
    const startStub = { x: startAnchor.x + ax * stub, y: startAnchor.y + ay * stub }
    // 短桩自身不能穿别的东西，桩点也不能落在别人肚子里
    if (grown.some((box) => strictlyInside(box, startStub))) continue
    if (grown.some((box) => segmentHitsBox(startAnchor, startStub, box))) continue

    for (let toIndex = 0; toIndex < SIDES.length; toIndex += 1) {
      const toSide = SIDES[toIndex]!
      const [bx, by] = OUTWARD[toSide]
      const endAnchor = port(to, toSide)
      const endStub = { x: endAnchor.x + bx * stub, y: endAnchor.y + by * stub }
      if (grown.some((box) => strictlyInside(box, endStub))) continue
      if (grown.some((box) => segmentHitsBox(endAnchor, endStub, box))) continue

      const middle = search(grid, startStub, endStub)
      if (middle === null) continue
      const full = simplify([startAnchor, ...middle, endAnchor])
      if (full.length < 2) continue

      choices.push({
        fromSide,
        toSide,
        // 只回填中间折点：两端锚点由渲染器按 anchor(box, side) 自行补上（同一公式）
        via: full.slice(1, -1).map((point) => [point.x, point.y] as [number, number]),
        corners: full.length - 2,
        length: pathLength(full),
        ok: pathMinSegment(full) >= minSegment - 1e-9,
        order: fromIndex * SIDES.length + toIndex,
      })
    }
  }

  if (choices.length === 0) return null

  // 全序：先「满足最短段」→ 折点数 → 总长 → 侧序。结果与枚举顺序无关。
  choices.sort(
    (a, b) =>
      Number(b.ok) - Number(a.ok) || a.corners - b.corners || a.length - b.length || a.order - b.order,
  )
  const best = choices[0]!
  return { fromSide: best.fromSide, toSide: best.toSide, route: 'straight', via: best.via }
}

/**
 * 该侧与节点边界的交点。与 archify 的 `anchor()` **同公式**，所以可以直接用来把
 * `RoutePlan.via` 补成渲染器真正会画的完整折线（`[anchor(from), ...via, anchor(to)]`）。
 */
export function anchorOf(box: RouterBox, side: RouterSide): [number, number] {
  const point = port(box, side)
  return [point.x, point.y]
}

/** 轴对齐矩形（标签占位用）。 */
export interface LabelRect {
  x0: number
  x1: number
  y0: number
  y1: number
}

export interface LabelPlacement {
  /** 直接喂给 archify 的 `labelAt` */
  at: [number, number]
  box: LabelRect
}

/** 两个轴对齐矩形的最小间隔：不相交时为正（真实距离），相交时为负（重叠深度）。 */
function rectSeparation(a: LabelRect, b: LabelRect): number {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1)
  const dy = Math.max(b.y0 - a.y1, a.y0 - b.y1)
  if (dx >= 0 || dy >= 0) return Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return -Math.min(-dx, -dy)
}

/**
 * 给一条已定路径挑一个「不压节点、也不压已放标签」的标签锚点。
 *
 * 为什么需要：archify 默认把标签放在 `labelSegment ?? 1` 那一段的中点上，
 * 而自动挑选的那一段经常正好从某个节点上方掠过 → `Label "x" overlaps component "y"`，
 * **整张图被拒**。与其被拒，不如自己挑位置（schema 有 `labelAt` 就是为这个）。
 *
 * 候选点取自路径各段的若干比例位置 × 若干纵向偏移（`0, ±16, ±30`），
 * 按（是否达标净空 → 最小间隔）取最优；并列时保持先出现的候选，故结果确定。
 *
 * @param size 标签矩形尺寸（宽高口径必须与调用方对应渲染器一致）
 * @param occupied 已经放下的标签矩形（避免标签互相重叠）
 * @param options.lift 标签锚点相对矩形的上抬量（architecture 10 / dataflow 11）
 * @param options.allowImperfect `true` 时连不达标的位置也返回（**标签是必填字段**的图
 *   只能这样：不完美地放一个，好过交给渲染器按中点放在更糟的地方）；`false` 时
 *   返回 `null`，调用方应当**丢掉这个标签但保留连线**（少一个标注好过整张图被拒）。
 */
export function pickLabelAt(
  points: ReadonlyArray<readonly [number, number]>,
  obstacles: readonly RouterBox[],
  size: { width: number; height: number },
  occupied: readonly LabelRect[] = [],
  options: { lift?: number; clearance?: number; allowImperfect?: boolean } = {},
): LabelPlacement | null {
  const lift = options.lift ?? 10
  const clearance = options.clearance ?? 3
  const fractions = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]
  const offsets = [0, -16, 16, -30, 30]

  let best: LabelPlacement | null = null
  let bestSeparation = -Infinity
  let bestClear = false

  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s]!
    const b = points[s + 1]!
    for (const fraction of fractions) {
      const onPathX = a[0] + (b[0] - a[0]) * fraction
      const onPathY = a[1] + (b[1] - a[1]) * fraction
      for (const offset of offsets) {
        const lx = onPathX
        const ly = onPathY + offset
        const box: LabelRect = {
          x0: lx - size.width / 2,
          x1: lx + size.width / 2,
          y0: ly - lift,
          y1: ly - lift + size.height,
        }
        let separation = Infinity
        for (const obstacle of obstacles) {
          separation = Math.min(separation, rectSeparation(box, obstacle))
        }
        for (const other of occupied) {
          separation = Math.min(separation, rectSeparation(box, other))
        }
        const clear = separation >= clearance
        // 全序：先「达标」，再「间隔更大」；并列时保持先出现的候选（段序 → 比例序 → 偏移序）
        if (best === null || (clear && !bestClear) || (clear === bestClear && separation > bestSeparation + 1e-6)) {
          best = { at: [lx, ly], box }
          bestSeparation = separation
          bestClear = clear
        }
      }
    }
  }

  if (best === null) return null
  if (!bestClear && options.allowImperfect !== true) return null
  return best
}

/**
 * 从节点矩形集合自动推导**空白走廊 / 通道**。
 *
 * 把各盒子的 x 区间（与 y 区间）投影到轴上、合并重叠，相邻区间的空隙中点即一条
 * 贯穿全图的空白线；首尾外侧再各补一条边距线。这样布线器不必依赖调用方手算几何，
 * 换了布局也不用改布线代码。
 *
 * @param margin 首尾外侧线相对边界的距离
 */
export function freeTracks(
  boxes: readonly RouterBox[],
  margin = 40,
): { corridors: number[]; channels: number[] } {
  const axis = (lo: (box: RouterBox) => number, hi: (box: RouterBox) => number): number[] => {
    if (boxes.length === 0) return []
    const spans = boxes
      .map((box) => [lo(box), hi(box)] as [number, number])
      .sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const span of spans) {
      const last = merged[merged.length - 1]
      if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
      else merged.push([span[0], span[1]])
    }
    const tracks: number[] = [merged[0]![0] - margin]
    for (let i = 0; i + 1 < merged.length; i++) {
      tracks.push((merged[i]![1] + merged[i + 1]![0]) / 2)
    }
    tracks.push(merged[merged.length - 1]![1] + margin)
    return tracks
  }
  return {
    corridors: axis((box) => box.x0, (box) => box.x1),
    channels: axis((box) => box.y0, (box) => box.y1),
  }
}

/**
 * 批量规划；**规划不出的边直接丢弃**（宁缺毋滥——画一条穿节点的线不如不画）。
 *
 * @returns 与 `edges` 同序、仅含成功方案的列表
 */
export function planRoutes<Edge>(
  edges: readonly Edge[],
  resolve: (edge: Edge) => { from: RouterBox; to: RouterBox } | null,
  obstacles: readonly RouterBox[],
  options: RouterOptions = {},
): Array<{ edge: Edge; plan: RoutePlan }> {
  const out: Array<{ edge: Edge; plan: RoutePlan }> = []
  for (const edge of edges) {
    const ends = resolve(edge)
    if (ends === null) continue
    const plan = planRoute(ends.from, ends.to, obstacles, options)
    if (plan !== null) out.push({ edge, plan })
  }
  return out
}
