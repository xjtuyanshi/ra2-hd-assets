import type { GameHotkeySheet } from '../hotkeys';

/**
 * Cheat sheet of Yuri's Revenge 1.001 with its default bindings as this page delivers them. Bindings: the [Hotkey]
 * section of the KEYBOARDMD.INI in the player's language pack, matched against the commands gamemd.exe registers
 * (docs/remaster/research/yr-hotkeys.md lists every command, its key value and what was tested). Mouse and modifier
 * operations were verified in a live match through the page's input path. "⌘" stands for the page's Apple-keyboard
 * mapping (⌘ acts as the game's Ctrl; Control itself works too).
 */
export const YR_HOTKEY_SHEET: GameHotkeySheet = Object.freeze({
  groups: [
    {
      // Observed in live matches on the pinned build (docs/remaster/research/yr-auto-attack.md); not key bindings.
      title: '部队什么时候会自己打',
      rows: [
        {
          keys: '闲着，有武器的敌人走进射程',
          action: '会打（射程最外面大约一格不算）',
          tip: '被打也会还手；但旁边的友军挨打它不管，每个单位只管自己够得着的。',
        },
        {
          keys: '旁边是没有武器的建筑',
          action: '不打，站多久都不打',
          tip: '电厂、兵营、建造厂都要你点名：左键点它；中立建筑要按住 ⌘ 再点。',
        },
        {
          keys: '左键点地面开进敌方基地',
          action: '到了只打射程内有武器的目标',
          tip: '开进去“傻站着”是原版规则，不是改版：基地里大多是没有武器的建筑。',
        },
        {
          keys: '⌘+Shift+左键（移动攻击）',
          action: '有武器的敌人进了射程会停下来打掉',
          tip: '推进用它；建筑仍然要自己点。',
        },
        {
          keys: 'G（区域警戒）',
          action: '主动走过去打十格左右内有武器的敌人',
          tip: '守家、守路口用它；步兵射程短，管得也近。',
        },
        {
          keys: '⌘+⌥+左键点自己的单位（护送）',
          action: '跟着它走，它打谁就一起打谁',
          tip: '没被编进护送的单位，十几格外看着也不会来帮忙。',
        },
      ],
    },
    {
      // Measured live (docs/remaster/research/yr-transport.md): flak track and IFV behave the same.
      title: '运兵车和工程师（皮包哥偷家）',
      rows: [
        {
          keys: '乘客从哪边下车',
          action: '车尾（车头的正后方）；后上的先下',
          tip: '按 D 后大约半秒出第一个，之后每隔一秒一个。盟军多功能步兵车一样。',
        },
        {
          keys: '怎么让车尾对着建筑',
          action: '先开到建筑旁边，再朝离开建筑的方向点一格',
          tip: '车头朝向就是最后一步的行驶方向。这是规则，不是手感。',
        },
        {
          keys: '最快的顺序',
          action: '上车前 ⌘+3 编队 → 开到位 → D → 3 → 左键点建筑',
          tip: '人在车里时编队键选不到他，下车后编队还在。要练的只有“D 之后马上 3、点建筑”。',
        },
      ],
    },
    {
      title: '镜头',
      rows: [
        { keys: '← ↑ → ↓', action: '滚动画面', tip: '手不离键盘就能挪镜头，用触控板时比右键拖动顺手。' },
        { keys: 'H', action: '回到基地（建造厂）', tip: '基地出事、要放建筑时一键回家。' },
        { keys: '空格', action: '跳到最近一次语音提示的地点', tip: '听到“遭到攻击”“建造完成”立刻按，比去点雷达快。' },
        {
          keys: 'Alt+1…0',
          macKeys: '⌥+1…0',
          action: '选中编队并把镜头移过去',
          tip: '多线操作时在几支部队之间来回切。',
        },
        {
          keys: 'F1…F4',
          macKeys: 'fn+F1…F4',
          action: '回到书签 1–4',
          tip: '矿区、前线、敌人门口各存一个，按一下就到。',
        },
        {
          keys: 'Ctrl+F1…F4',
          macKeys: '⌘+fn+F1…F4',
          action: '把当前画面存成书签 1–4',
          tip: '开局先给自己的矿区存一个。',
        },
        {
          keys: 'F',
          action: '镜头跟随选中的单位（再按一次取消）',
          tip: '跟随时方向键不起作用；画面“卡住”多半是误按了它。',
        },
        { keys: '右键按住拖动', action: '拖动画面', tip: '想细调位置时用；大范围移动还是方向键和雷达快。' },
      ],
    },
    {
      title: '选择',
      rows: [
        { keys: '左键单击 / 拖框', action: '选中一个 / 框选一片', tip: '框选从空地起手，别从单位身上起手。' },
        { keys: '双击单位，或选中后按 T', action: '选中屏幕里所有同类单位', tip: '新造的坦克散在各处时一次拢起来。' },
        {
          keys: 'Shift+单击 / 拖框',
          action: '加选；点已选中的单位则减选',
          tip: '往选好的部队里补几个单位，不用重新框。',
        },
        { keys: 'P', action: '选中地图上全部战斗单位', tip: '全军出击或全军回防时用。' },
        { keys: 'N / M', action: '下一个 / 上一个单位', tip: '找闲着没事的单位。' },
        { keys: 'Y', action: '按等级挑选单位', tip: '把升了星的老兵挑出来单独保护。' },
        {
          keys: '右键单击空地',
          action: '取消选择；也用来取消放置、退出修理和变卖',
          tip: '下错命令前先右键，手就干净了。',
        },
      ],
    },
    {
      title: '编队',
      rows: [
        {
          keys: 'Ctrl+1…0',
          macKeys: '⌘+1…0',
          action: '把选中的单位编成 1–10 队',
          tip: '主力坦克 1 队、防空 2 队、特殊单位 3 队，养成固定习惯。',
        },
        { keys: '1…0', action: '选中该队', tip: '交战中用数字键切部队，比框选快得多。' },
        {
          keys: 'Shift+1…0',
          macKeys: '⇧+1…0',
          action: '把该队加进当前选择',
          tip: '新坦克出厂后：选中它，Shift+1，再 ⌘+1 并进 1 队。',
        },
      ],
    },
    {
      title: '命令',
      rows: [
        { keys: '左键点地面 / 点敌人', action: '移动 / 攻击', tip: '集火：全队点同一个目标，先打掉一个再换下一个。' },
        {
          keys: 'Ctrl+左键',
          macKeys: '⌘+左键',
          action: '强制攻击（地面、桥、中立或自己的东西）',
          tip: '封路口、清树、炸桥，或者打掉挡路的东西。',
        },
        {
          keys: 'Alt+左键',
          macKeys: '⌥+左键',
          action: '强制移动；坦克会直接压过步兵',
          tip: '坦克对步兵最省血的打法就是碾过去。',
        },
        {
          keys: 'Ctrl+Shift+左键',
          macKeys: '⌘+⇧+左键',
          action: '移动攻击：开过去，路上遇敌就打',
          tip: '推进时用它，部队不会一路挨打走到头。',
        },
        {
          keys: 'Ctrl+Alt+左键点自己的单位',
          macKeys: '⌘+⌥+左键点自己的单位',
          action: '护送它',
          tip: '让防空车跟着主力坦克走。',
        },
        { keys: 'S', action: '停止', tip: '走错路、追过头时马上按。' },
        { keys: 'X', action: '散开', tip: '步兵躲碾压、坦克躲范围伤害。' },
        { keys: 'G', action: '区域警戒', tip: '放在路口，敌人靠近会主动迎上去。' },
        { keys: 'D', action: '部署（基地车展开、步兵蹲下等）', tip: '开局第一件事：选中基地车按 D。' },
        {
          keys: '按住 Z 依次点地面，松开 Z',
          action: '路径点：按顺序走完这些点',
          tip: '让部队绕开防御，或几路同时出发。',
        },
      ],
    },
    {
      title: '建造',
      rows: [
        {
          keys: 'Q / W / E / R',
          action: '建筑 / 防御 / 步兵 / 车辆页',
          tip: '不用鼠标找页签；页里没有东西时切不过去。',
        },
        { keys: '左键点图标', action: '开始建造；造好后再点一次，到地图上放置', tip: '钱够就别让建造厂闲着。' },
        { keys: '右键点图标', action: '暂停；再右键一次取消并退钱', tip: '钱不够时先停掉不急的。' },
        { keys: '选中兵营或工厂后左键点地面', action: '设集结点', tip: '把集结点设在前线后方，新兵不用再手动拉。' },
        { keys: 'K', action: '修理模式（再按一次退出）', tip: '打完一波马上修，别等下一波。' },
        { keys: 'L', action: '变卖模式（再按一次退出）', tip: '守不住的建筑先卖掉，能换回一部分钱。' },
        {
          keys: 'Shift+左键点图标',
          action: '连点 10 次（网页功能，只在右侧建造栏有效）',
          tip: '一次排 10 个兵或 10 辆坦克。',
        },
      ],
    },
    {
      title: '其他',
      rows: [
        { keys: 'Esc', action: '游戏菜单（游戏暂停；点“回到任务”继续）', tip: '需要停下来想一想时用。' },
        {
          keys: 'A / B / C / U，F5…F12',
          macKeys: 'A / B / C / U，fn+F5…F12',
          action: '结盟 / 信标 / 欢呼 / 呼叫玩家，叫嚣',
          tip: '只在联机对战里有用。',
        },
      ],
    },
  ],
  notes: [
    '这台 Mac 上：⌘ 就是游戏里的 Ctrl（Control 键本身也可以用）；Option（⌥）就是 Alt。',
    'F1–F12 要同时按 fn，除非在“系统设置 › 键盘”里打开“将 F1、F2 等键用作标准功能键”。Control+F2/F3/F4 被 macOS 占用，设书签请用 ⌘。',
    'MacBook 自带键盘没有小键盘：“观点置中”（小键盘 5）、建造栏上下卷（小键盘 8 / 2）、“删除”（小键盘 .）这几个默认键按不到；建造栏可以用鼠标点下方的箭头。',
    '⌘+W、⌘+Q、⌘+H、⌘+M、⌘+Tab 归浏览器和 macOS 所有：按住 ⌘ 时别碰 W、Q、H、M。全屏后网页会向浏览器申请键盘锁，能挡住其中一部分。',
    '网页自己占用的键：[ 和 ]（时钟倍率）、\\（高清 / 原版）、?（网页帮助）、F11（全屏）；` 在训练启动器里已还给游戏。',
    '网上流传的几个说法在这个版本里不成立：U 不是“按血量选兵”（它是呼叫玩家，“生命值顺序”默认没有键）；Alt+左键不是路径点（Z 才是）；Ctrl+左键不是移动攻击（它是强制攻击）。',
  ],
});
