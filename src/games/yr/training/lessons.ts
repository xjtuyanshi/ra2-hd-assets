import type { GameCommandObject, GameCommandState } from '../../commandState';
import {
  byUid,
  centroid,
  chordWithEffect,
  inGroup,
  isSelected,
  lastChord,
  ofKind,
  ofType,
  own,
  pick,
  selection,
  usedChord,
  viewCentreDistance,
  viewShows,
  viewTravel,
  withMission,
  type TrainingProjection,
} from '../../shared/trainingDetectors';
import type { TrainingContext, TrainingLesson } from '../../training';

/**
 * Practice lessons of Yuri's Revenge 1.001 with the default key bindings (the KEYBOARDMD.INI of the player's language
 * pack; see docs/remaster/research/yr-hotkeys.md). Each lesson runs on a prepared scenario
 * (scripts/remaster/training/buildScenarios.py): the Soviet side with its kit at the start, passive targets nearby.
 * Texts are Chinese source strings, translated at the presentation boundary.
 *
 * Type names: HTNK Rhino tank, HTK flak track, E2 conscript, SMCV Soviet MCV, NACNST construction yard, NAPOWR
 * tesla reactor, NAHAND barracks, NALASR sentry gun, CIV1..3 civilians.
 */

/** World point to world pixel: 60 x 30 pixel cells of 256 units, 15 pixels per 104 units of height. */
export const yrProjection: TrainingProjection = (point) => ({
  x: ((point.x - point.y) * 30) / 256,
  y: ((point.x + point.y) * 15) / 256 - (point.z * 15) / 104,
});

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const LEFT = 'Mouse0';
const CELL = 256;
const tanks = ofType('HTNK');
const troops = ofType('E2');
const mobile = ofKind('vehicle', 'infantry');
const civilians = ofType('CIV1', 'CIV2', 'CIV3');
const ownMobile = (state: GameCommandState) => pick(state, own, mobile);
const sameUids = (a: readonly GameCommandObject[], b: readonly GameCommandObject[]) =>
  a.length === b.length && a.every((object) => b.some((other) => other.uid === object.uid));
const isEnemy = (state: GameCommandState, uid: number) => {
  const object = byUid(state, uid);
  return !!object && object.owner !== state.localHouse;
};
/** Selected own units that currently carry an order of one of the missions, with what `match` asks of them. */
const ordered = (context: TrainingContext, missions: string[], match: (object: GameCommandObject) => boolean) =>
  selection(context.state).filter((object) => withMission(...missions)(object, context.state) && match(object));
/** World point of a cell centre, at the height of the player's base (the scenarios are built on flat ground). */
const cellPoint = (state: GameCommandState, cell: { x: number; y: number }) => ({
  x: cell.x * CELL + CELL / 2,
  y: cell.y * CELL + CELL / 2,
  z: pick(state, own, ofType('NACNST'))[0]?.z ?? 0,
});
/** The lesson's kit was handed over: the player owns Rhino tanks. */
const kitReady = (state: GameCommandState) => pick(state, own, tanks).length >= 3;

const camera: TrainingLesson = {
  id: 'yr-camera',
  title: '第 1 课 镜头与选择',
  summary: '方向键滚屏、回基地、跳到事件、框选、选同类、加选。',
  scenario: 'basic',
  ready: kitReady,
  hotkeys: [
    { chords: ARROWS, label: '方向键 滚动画面' },
    { chords: ['KeyH'], label: 'H 回到基地' },
    { chords: ['Space'], label: '空格 跳到最近的事件' },
    { chords: ['Drag0'], label: '左键拖框 框选' },
    { chords: ['KeyT', 'Double0'], label: 'T / 双击 选同类' },
    { chords: ['Shift+Mouse0', 'Shift+Drag0'], label: 'Shift+左键 加选' },
    { chords: ['KeyP'], label: 'P 选中全部战斗单位' },
    { chords: ['Mouse2'], label: '右键 取消选择' },
  ],
  tasks: [
    {
      id: 'scroll',
      title: '方向键滚动画面',
      instruction: '按住键盘方向键，把画面移开至少半个屏幕。',
      hint: '键盘右下角的 ← ↑ → ↓。先用鼠标点一下战场，让游戏画面获得键盘。',
      detect: (context) => usedChord(context, ARROWS) && viewTravel(context) >= 300,
    },
    {
      id: 'base',
      title: 'H 回到基地',
      instruction: '按 H，镜头回到你的建造厂。',
      hint: '直接按字母键 H（不用按 Shift）。如果没反应，先点一下战场。',
      detect: chordWithEffect(['KeyH'], ({ state }) =>
        viewShows(state, yrProjection, centroid(pick(state, own, ofType('NACNST'))), 40),
      ),
    },
    {
      id: 'event',
      title: '空格跳到事件',
      instruction: '远处的前哨遭到攻击，雷达上有一个闪动的圈。按空格，镜头直接跳到出事的地方。',
      hint: '按一下空格键。（连按两下会跳到更早的一次事件。）',
      detect: chordWithEffect(
        ['Space'],
        ({ state }) =>
          !!state.lastEvent &&
          viewCentreDistance(state, yrProjection, cellPoint(state, state.lastEvent)) < 200 &&
          !viewShows(state, yrProjection, centroid(pick(state, own, ofType('NACNST'))), 0),
        2500,
      ),
    },
    {
      id: 'return',
      title: '再按 H 回来',
      instruction: '看完就回家：再按一次 H。',
      hint: '按 H。',
      detect: chordWithEffect(['KeyH'], ({ state }) =>
        viewShows(state, yrProjection, centroid(pick(state, own, ofType('NACNST'))), 40),
      ),
    },
    {
      id: 'box',
      title: '框选',
      instruction: '按住左键拖出一个方框，一次框住至少 3 个单位。',
      hint: '在单位左上方的空地按下左键，拖到右下方再松开。',
      detect: chordWithEffect(['Drag0'], ({ state }) => selection(state).length >= 3),
    },
    {
      id: 'deselect',
      title: '右键取消选择',
      instruction: '在空地上点一下右键，取消选择。',
      hint: '触控板：双指轻点；鼠标：右键。',
      detect: chordWithEffect(['Mouse2'], ({ state }) => selection(state).length === 0),
    },
    {
      id: 'type',
      title: '选同类',
      instruction: '点一辆犀牛坦克，再按 T（或直接双击它）：屏幕里所有犀牛坦克都被选中。',
      hint: '先左键单击一辆坦克，再按 T。',
      detect: chordWithEffect(['KeyT', 'Double0'], ({ state }) => {
        const chosen = selection(state);
        return chosen.length >= 3 && chosen.every((object) => object.type === chosen[0]!.type);
      }),
    },
    {
      id: 'add',
      title: 'Shift 加选',
      instruction: '保持坦克被选中，按住 Shift 再点（或框）动员兵，把他们加进来。',
      hint: '按住 Shift 不放，左键点一个动员兵。选中的单位里要同时有坦克和步兵。',
      detect: chordWithEffect(['Shift+Mouse0', 'Shift+Drag0'], ({ state }) => {
        const chosen = selection(state);
        return chosen.some((o) => o.kind === 'vehicle') && chosen.some((o) => o.kind === 'infantry');
      }),
    },
    {
      id: 'all',
      title: 'P 全选战斗单位',
      instruction: '按 P：地图上你所有的战斗单位一次全选。',
      hint: '按字母键 P。',
      detect: chordWithEffect(['KeyP'], ({ state }) => selection(state).length >= ownMobile(state).length - 1),
    },
  ],
};

const teams: TrainingLesson = {
  id: 'yr-teams',
  title: '第 2 课 编队',
  summary: '建立编队、叫回编队、加选编队、把镜头切到编队。',
  scenario: 'basic',
  ready: kitReady,
  hotkeys: [
    { chords: ['Ctrl+Digit1', 'Ctrl+Digit2'], label: 'Ctrl/⌘+数字 建立编队' },
    { chords: ['Digit1', 'Digit2'], label: '数字 选中编队' },
    { chords: ['Shift+Digit1', 'Shift+Digit2'], label: 'Shift+数字 加选编队' },
    { chords: ['Alt+Digit1', 'Alt+Digit2'], label: 'Option+数字 选中并把镜头移过去' },
  ],
  tasks: [
    {
      id: 'make1',
      title: '坦克编为 1 队',
      instruction: '选中犀牛坦克（至少 3 辆），按 ⌘+1（或 Control+1）。',
      hint: '先框选或用 T 选中坦克；按住 ⌘ 再按数字 1。',
      detect: chordWithEffect(['Ctrl+Digit1'], ({ state }) => pick(state, own, tanks, inGroup(0)).length >= 3),
    },
    {
      id: 'make2',
      title: '步兵编为 2 队',
      instruction: '选中动员兵（至少 3 个），按 ⌘+2。',
      hint: '点一个动员兵再按 T 选中全部，然后 ⌘+2。',
      detect: chordWithEffect(['Ctrl+Digit2'], ({ state }) => pick(state, own, troops, inGroup(1)).length >= 3),
    },
    {
      id: 'recall1',
      title: '按 1 叫回 1 队',
      instruction: '按数字 1：1 队被选中，其他单位不再被选中。',
      hint: '只按数字键 1，不要按 ⌘ 或 Shift。',
      detect: chordWithEffect(['Digit1'], ({ state }) => {
        const group = pick(state, own, inGroup(0));
        return group.length > 0 && sameUids(selection(state), group);
      }),
    },
    {
      id: 'add2',
      title: 'Shift+2 加选 2 队',
      instruction: '1 队还选着，按 Shift+2 把 2 队也加进来。',
      hint: '按住 Shift 再按数字 2。',
      detect: chordWithEffect(['Shift+Digit2'], ({ state }) => {
        const chosen = selection(state);
        return chosen.some((o) => o.group === 0) && chosen.some((o) => o.group === 1);
      }),
    },
    {
      id: 'away',
      title: '把镜头移开',
      instruction: '用方向键把画面移到看不见部队的地方。',
      hint: '按住方向键一两秒。',
      detect: (context) =>
        usedChord(context, ARROWS) &&
        !pick(context.state, own, inGroup(0)).some((object) => viewShows(context.state, yrProjection, object, 0)),
    },
    {
      id: 'jump1',
      title: 'Option+1 跳到 1 队',
      instruction: '按 Option+1：选中 1 队，镜头同时移到它们身上。',
      hint: '按住 Option（⌥）再按数字 1。',
      detect: chordWithEffect(['Alt+Digit1'], ({ state }) => {
        const group = pick(state, own, inGroup(0));
        return group.length > 0 && viewCentreDistance(state, yrProjection, centroid(group)) < 260;
      }),
    },
  ],
};

const orders: TrainingLesson = {
  id: 'yr-orders',
  title: '第 3 课 下命令',
  summary: '移动、停止、攻击、强制攻击、强制移动碾压、移动攻击、散开、警戒、护送。',
  scenario: 'basic',
  ready: kitReady,
  hotkeys: [
    { chords: ['KeyS'], label: 'S 停止' },
    { chords: ['Ctrl+Mouse0'], label: 'Ctrl/⌘+左键 强制攻击' },
    { chords: ['Alt+Mouse0'], label: 'Option+左键 强制移动（碾压）' },
    { chords: ['Ctrl+Shift+Mouse0'], label: 'Ctrl/⌘+Shift+左键 移动攻击' },
    { chords: ['KeyX'], label: 'X 散开' },
    { chords: ['KeyG'], label: 'G 警戒' },
    { chords: ['Ctrl+Alt+Mouse0'], label: 'Ctrl/⌘+Option+左键 护送' },
  ],
  tasks: [
    {
      id: 'move',
      title: '移动',
      instruction: '选中犀牛坦克，左键点一块空地，让它们开过去。',
      hint: '先选中坦克（框选或 T），再在空地上点一下左键。',
      detect: chordWithEffect(
        [LEFT],
        (context) => ordered(context, ['Move'], (o) => o.kind === 'vehicle' && o.destination?.kind === 'cell').length >= 2,
      ),
    },
    {
      id: 'stop',
      title: 'S 停止',
      instruction: '坦克还在路上时按 S，让它们立刻停下。',
      hint: '先下一个远一点的移动命令，坦克开动后按 S。',
      detect: (context) => {
        const moving = selection(context.state).some((object) => object.destination !== null);
        if (moving && !usedChord(context, ['KeyS'])) context.memo.set('moving', true);
        const key = lastChord(context.inputs, ['KeyS']);
        if (!key || !context.memo.get('moving')) return 0;
        const chosen = selection(context.state);
        return chosen.length >= 1 && chosen.every((object) => object.destination === null) ? 1 : 0.5;
      },
    },
    {
      id: 'attack',
      title: '攻击',
      instruction: '基地前方有两座敌方电厂。选中坦克，左键点其中一座。',
      hint: '把鼠标移到敌方建筑上，光标变成红色准星后点左键。',
      detect: chordWithEffect(
        [LEFT],
        (context) =>
          ordered(
            context,
            ['Attack'],
            (o) => o.target?.kind === 'object' && isEnemy(context.state, o.target.uid),
          ).length >= 1,
      ),
    },
    {
      id: 'force-fire',
      title: '强制攻击',
      instruction: '按住 ⌘（或 Control）点一块空地：坦克会朝那块地开火。封路、清树、打桥都用它。',
      hint: '先按 S 停火，再按住 ⌘ 不放，左键点空地。',
      detect: chordWithEffect(
        ['Ctrl+Mouse0'],
        (context) => ordered(context, ['Attack'], (o) => o.target?.kind === 'cell').length >= 1,
      ),
    },
    {
      id: 'crush',
      title: '强制移动碾压',
      instruction: '旁边站着几个平民。选中坦克，按住 Option 点一个平民：坦克会直接压过去。',
      hint: '按住 Option（⌥）不放，把鼠标移到平民身上点左键。压到一个就算完成。',
      detect: (context) => {
        const before = pick(context.origin, civilians).length;
        const now = pick(context.state, civilians).length;
        if (!usedChord(context, ['Alt+Mouse0'])) return 0;
        return now < before ? 1 : 0.5;
      },
    },
    {
      id: 'attack-move',
      title: '移动攻击',
      instruction: '按住 ⌘+Shift 点敌方电厂附近的空地：部队开过去，路上遇敌就打。',
      hint: '同时按住 ⌘ 和 Shift，左键点一块空地。',
      detect: chordWithEffect(
        ['Ctrl+Shift+Mouse0'],
        (context) => ordered(context, ['Move', 'AttackMove', 'Attack'], (o) => o.destination !== null).length >= 1,
      ),
    },
    {
      id: 'scatter',
      title: 'X 散开',
      instruction: '让坦克停下（S），再按 X：它们会各自挪开几步。躲碾压、躲范围伤害就靠它。',
      hint: '选中至少 2 个单位，按字母键 X。',
      detect: (context) => {
        const key = lastChord(context.inputs, ['KeyX']);
        if (!key) return 0;
        const chosen = selection(context.state);
        const moved = chosen.filter((object) => {
          const before = byUid(context.origin, object.uid);
          return object.destination !== null || (!!before && Math.hypot(object.x - before.x, object.y - before.y) > CELL / 2);
        });
        return chosen.length >= 2 && moved.length >= 1 && context.time - key.time < 4000 ? 1 : 0.5;
      },
    },
    {
      id: 'guard',
      title: 'G 警戒',
      instruction: '选中坦克按 G：它们守住这一片，敌人靠近会主动迎上去。',
      hint: '按字母键 G。',
      detect: chordWithEffect(['KeyG'], (context) => ordered(context, ['Area_Guard'], () => true).length >= 1),
    },
    {
      id: 'escort',
      title: '护送',
      instruction: '选中防空履带车，按住 ⌘+Option 点一辆犀牛坦克：防空车会跟着它走。',
      hint: '先选中防空履带车；同时按住 ⌘ 和 Option，左键点一辆自己的坦克。',
      detect: chordWithEffect(
        ['Ctrl+Alt+Mouse0'],
        (context) =>
          ordered(
            context,
            ['Area_Guard'],
            (o) => o.focus?.kind === 'object' && byUid(context.state, o.focus.uid)?.owner === context.state.localHouse,
          ).length >= 1,
      ),
    },
  ],
};

const tabOf = (state: GameCommandState) => state.sidebar?.activeTab ?? -1;
const count = (state: GameCommandState, ...types: string[]) => pick(state, own, ofType(...types)).length;

const build: TrainingLesson = {
  id: 'yr-build',
  title: '第 4 课 建造与生产',
  summary: '部署、页签键、放置建筑、集结点、修理与变卖、边打边造。',
  scenario: 'build',
  ready: (state) => pick(state, own, tanks).length >= 2,
  hotkeys: [
    { chords: ['KeyD'], label: 'D 部署' },
    { chords: ['KeyQ'], label: 'Q 建筑页' },
    { chords: ['KeyW'], label: 'W 防御页' },
    { chords: ['KeyE'], label: 'E 步兵页' },
    { chords: ['KeyR'], label: 'R 车辆页' },
    { chords: ['KeyK'], label: 'K 修理模式' },
    { chords: ['KeyL'], label: 'L 变卖模式' },
  ],
  tasks: [
    {
      id: 'deploy',
      title: 'D 部署基地车',
      instruction: '点选基地车，按 D 把它展开成建造厂。',
      hint: '基地车是最大的那辆车。单击选中它，再按字母键 D。',
      detect: chordWithEffect(['KeyD'], ({ state }) => count(state, 'NACNST') >= 1, 12_000),
    },
    {
      id: 'power',
      title: '造电厂并放下',
      instruction: '在右侧建造栏点“磁能反应炉”，造好后再点一次图标，在建造厂旁边点左键放下。',
      hint: '图标上出现“就绪”后：点图标，把鼠标移到基地旁的空地，格子全绿时点左键。',
      hintAfterMs: 40_000,
      detect: (context) => (count(context.state, 'NAPOWR') > count(context.origin, 'NAPOWR') ? 1 : 0),
    },
    {
      id: 'barracks',
      title: '造兵营并放下',
      instruction: '同样的做法造一座兵营。',
      hint: '建筑页里的“兵营”。电厂放下以后它才会出现。',
      hintAfterMs: 40_000,
      detect: (context) => (count(context.state, 'NAHAND') >= 1 ? 1 : 0),
    },
    {
      id: 'tab-infantry',
      title: 'E 切到步兵页',
      instruction: '按 E，建造栏切到步兵页。（Q 建筑、W 防御、E 步兵、R 车辆）',
      hint: '按字母键 E。步兵页里有东西时才切得过去。',
      detect: chordWithEffect(['KeyE'], ({ state }) => tabOf(state) === 2),
    },
    {
      id: 'rally',
      title: '设集结点',
      instruction: '点选兵营，再在基地外的空地上点一下左键：以后造出来的兵都会走到那里。',
      hint: '先单击兵营（它被选中后有一圈框），再左键点空地。',
      detect: chordWithEffect([LEFT], ({ state }) =>
        pick(state, own, ofType('NAHAND'), isSelected).some((object) => object.focus?.kind === 'cell'),
      ),
    },
    {
      id: 'train',
      title: '造 3 个动员兵',
      instruction: '在步兵页连点三下“动员兵”，等他们走到集结点。',
      hint: '按 E 回到步兵页，左键点动员兵图标三次。',
      hintAfterMs: 40_000,
      detect: (context) => Math.min(1, (count(context.state, 'E2') - count(context.origin, 'E2')) / 3),
    },
    {
      id: 'tab-build',
      title: 'Q 回建筑页',
      instruction: '按 Q 回到建筑页。',
      hint: '按字母键 Q。',
      detect: chordWithEffect(['KeyQ'], ({ state }) => tabOf(state) === 0),
    },
    {
      id: 'repair',
      title: 'K 修理',
      instruction: '基地旁那座冒烟的电厂只剩不到一半血。按 K 进入修理模式，点它一下，再按 K 退出。',
      hint: '按 K 后鼠标变成扳手，左键点受损的电厂。',
      detect: (context) => {
        if (!usedChord(context, ['KeyK'])) return 0;
        const healed = pick(context.state, own, ofType('NAPOWR')).some((object) => {
          const before = byUid(context.origin, object.uid);
          return !!before && before.health < 0.6 && object.health > before.health + 0.02;
        });
        return healed ? 1 : 0.5;
      },
    },
    {
      id: 'sell',
      title: 'L 变卖',
      instruction: '基地旁有一座用不上的哨戒炮。按 L 进入变卖模式，点它把它卖掉。',
      hint: '按 L 后鼠标变成 $，左键点哨戒炮；卖完再按 L 退出。',
      detect: (context) => {
        if (!usedChord(context, ['KeyL'])) return 0;
        return count(context.state, 'NALASR') < count(context.origin, 'NALASR') ? 1 : 0.5;
      },
    },
    {
      id: 'multitask',
      title: '边打边造',
      instruction: '让坦克去打前方的敌方电厂；趁它们开火时按 E，再造 2 个动员兵。前线和后方不能只顾一头。',
      hint: '先选中坦克点敌方电厂；不用等它打完，马上按 E 点动员兵。',
      hintAfterMs: 45_000,
      detect: (context) => {
        const fighting = pick(context.state, own, tanks, withMission('Attack')).some(
          (object) => object.target?.kind === 'object' && isEnemy(context.state, object.target.uid),
        );
        if (fighting && count(context.state, 'E2') > ((context.memo.get('troops') as number | undefined) ?? Infinity)) {
          context.memo.set('made', ((context.memo.get('made') as number | undefined) ?? 0) + 1);
        }
        context.memo.set('troops', count(context.state, 'E2'));
        const made = (context.memo.get('made') as number | undefined) ?? 0;
        if (!usedChord(context, ['KeyE'])) return Math.min(0.4, made / 5);
        return Math.min(1, made / 2);
      },
    },
  ],
};

/** In teaching order. */
export const YR_TRAINING_LESSONS: readonly TrainingLesson[] = Object.freeze([camera, teams, orders, build]);
