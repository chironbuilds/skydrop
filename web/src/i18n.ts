// Simplified Chinese for the whole app, applied to the page after it renders: exact strings, a few sentence
// patterns for the ones that carry an amount or a handle, and a MutationObserver so later renders are covered too.
// English stays the source of truth in the code; choosing English reloads the page without the observer.

const KEY = "skydrop.lang";

export type Lang = "en" | "zh";

export function currentLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* storage can be blocked */
  }
  return typeof navigator !== "undefined" && /^zh/i.test(navigator.language) ? "zh" : "en";
}

export function setLang(l: Lang): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
  location.reload();
}

const ZH: Record<string, string> = {
  // chrome
  Send: "发送",
  Collect: "领取",
  "Tip by post": "发帖打赏",
  "How it works": "工作原理",
  Testnet: "测试网",
  "Your wallet": "你的钱包",
  "Tari testnet: tTARI has no monetary value.": "Tari 测试网：tTARI 没有货币价值。",
  "Escrow contract": "托管合约",
  "· verified on-chain, no oracle, no middleman": "· 链上验证，无预言机，无中间人",
  "Trustless · verified on-chain": "无需信任 · 链上验证",
  "Send Tari to": "把 Tari 发给 Bluesky 上的",
  anyone: "任何人",
  "on Bluesky": "",
  "Type a handle, pick an amount, done. They collect it by proving they own the account. No wallet to set up first, no middleman holding the money.":
    "输入用户名，选好金额，就这么简单。对方只需证明自己拥有该账号即可领取。无需先建钱包，也没有中间人保管资金。",
  "Pick a Bluesky handle and an amount. We hold it safely on-chain until they claim it.": "选择 Bluesky 用户名和金额。在对方领取之前，资金安全地锁在链上。",
  "Fund a budget once, then tip anyone by posting a line on Bluesky. Nobody holds your keys.": "先充值一次打赏额度，之后在 Bluesky 发一句话就能打赏任何人。没有人掌管你的密钥。",
  "Someone sent you tTARI? Post one line on Bluesky to prove it's you, then collect.": "有人给你发了 tTARI？在 Bluesky 发一句话证明是你，然后领取。",
  "No oracle": "没有预言机",
  "The contract itself checks your account's cryptographic signatures. Nobody vouches for you.": "合约自己校验你账号的密码学签名，无需任何人担保。",
  "Always refundable": "随时可退",
  "Unclaimed money returns to the sender after a set time.": "无人领取的资金会在设定时间后退回发送者。",
  "Nothing to install": "无需安装",
  "It works in your browser. A wallet is made for you in the background.": "直接在浏览器中使用，钱包会在后台自动为你创建。",
  // send
  "Send Tari to a Bluesky handle": "发送 Tari 给 Bluesky 用户",
  "Held on-chain until they prove they own the account.": "资金锁在链上，直到对方证明自己拥有该账号。",
  "Your sends": "我发出的",
  "To (Bluesky handle)": "收款人（Bluesky 用户名）",
  "Bluesky handle": "Bluesky 用户名",
  Amount: "金额",
  Envelope: "红包封面",
  "Your own picture": "自选图片",
  "Change picture": "更换图片",
  "Any image": "任意图片",
  "Or start from a design:": "或选择现成设计：",
  Lantern: "灯笼",
  Fireworks: "烟花",
  Coins: "金币",
  Blossom: "花开",
  Airmail: "航空信",
  "Red packet": "红包",
  Gold: "金色",
  Sakura: "樱花",
  Midnight: "午夜",
  Mint: "薄荷",
  Classic: "经典",
  Festive: "喜庆",
  Soft: "柔和",
  Dark: "深色",
  Fresh: "清新",
  "Tap the envelope to peek inside.": "点一下红包看看里面。",
  "Remove picture": "移除图片",
  "Tap the envelope": "点开红包",
  "Preparing your cover…": "正在准备封面…",
  "Optional. The envelope and note travel in the claim link you share, so they see it when they open it.": "可选。封面和留言会附在你分享的领取链接里，对方打开时就能看到。",
  "Challenge (optional)": "挑战（可选）",
  "Make them post something specific. The money is only released if their claim post contains this exact phrase (capital letters and all), and the contract checks it. If they never post it, you can take your money back after the refund time.":
    "让对方发一句指定的话。只有对方的领取帖子里包含这句话（大小写完全一致），资金才会释放，由合约自己校验。如果对方一直不发，退款时间到后你可以取回资金。",
  "Safety level": "安全等级",
  "Each payment sets its own safety window. It protects against someone using a stolen Bluesky key to collect, by giving the real owner time to cancel it.":
    "每笔付款可以设置自己的安全期。如果有人盗用 Bluesky 密钥来领取，安全期让真正的主人有时间取消。",
  Instant: "即时",
  Careful: "谨慎",
  Vault: "保险库",
  "Recommended for small amounts": "小额推荐",
  Tips: "打赏",
  "They can collect the moment they verify. Best for tips and small gifts.": "对方验证后立刻就能领取。适合打赏和小额礼物。",
  "A short safety window before it can be collected, so the real owner can stop a hijacked claim.": "领取前有一段较短的安全期，真正的主人可以拦截被盗用的领取。",
  "A longer safety window for larger transfers.": "更长的安全期，适合大额转账。",
  "Happy birthday! Buy yourself a coffee.": "生日快乐！请你喝杯咖啡。",
  "e.g. I love Tari": "例如：我爱 Tari",
  Dispatched: "已寄出",
  "On its way": "在路上了",
  "Tell them on Bluesky": "在 Bluesky 通知对方",
  "Copy claim link": "复制领取链接",
  "Send another": "再发一笔",
  "Sending…": "发送中…",
  "Link copied": "链接已复制",
  "Text copied": "文字已复制",
  "Address copied": "地址已复制",
  "Copy address": "复制地址",
  Copy: "复制",
  Close: "关闭",
  "Open Bluesky": "打开 Bluesky",
  "This wallet has no tTARI for network fees yet.": "这个钱包还没有用于网络手续费的 tTARI。",
  "Get some tTARI": "获取 tTARI",
  "Get free testnet tTARI": "领取免费测试币 tTARI",
  // tips page
  "Tip by posting": "发帖打赏",
  Budget: "额度",
  "Largest single tip": "单笔最高打赏",
  "Safety level for tips": "打赏的安全等级",
  "Fund tip budget": "充值打赏额度",
  "Add to tip budget": "追加打赏额度",
  "Withdraw it all": "全部取回",
  "Budget withdrawn": "额度已取回",
  "Funding…": "充值中…",
  "Tip budget funded": "打赏额度已充值",
  "Your Bluesky account": "你的 Bluesky 账号",
  "Put aside": "划拨金额",
  "A hard cap per post. Keep it small: it limits what a stolen Bluesky key could spend.": "每条帖子的硬性上限。建议设小一点：即使 Bluesky 密钥被盗，损失也有限。",
  "Safety level for people you tip": "被打赏者的安全等级",
  "Post it from this account, mention the person you are tipping, then the amount. The bot relays your post to the contract, which checks your signature itself. Each post tips once.":
    "用这个账号发帖，@ 要打赏的人，再写金额。机器人会把你的帖子转交给合约，合约自己校验你的签名。每条帖子只打赏一次。",
  "Only the wallet that funded the budget can withdraw it, any time. Anyone who controls the Bluesky account can spend it by posting a tip, so only put aside what you are happy to tip. The network fee for each tip (about 0.06 tTARI) comes out of the budget.":
    "只有充值的钱包可以随时取回额度。任何控制该 Bluesky 账号的人都能通过发帖花掉它，所以只划拨你愿意打赏的金额。每笔打赏的网络手续费（约 0.06 tTARI）从额度中扣除。",
  // claim
  "Collect your tTARI": "领取你的 tTARI",
  "Enter your Bluesky handle. You'll post one line to prove it's you.": "输入你的 Bluesky 用户名，发一句话证明是你。",
  "Your Bluesky handle": "你的 Bluesky 用户名",
  "Post this on Bluesky": "在 Bluesky 发布这段话",
  "Post it from your account (so everyone can see it). It ties this claim to your wallet, and you can delete the post afterwards.": "用你的账号公开发布（让所有人可见）。它把这次领取和你的钱包绑定，之后可以删除这条帖子。",
  "Prove it's you": "证明是你",
  "We fetch the signed copy of your post straight from Bluesky. The contract checks the signatures itself. Nobody has to trust us.": "我们直接从 Bluesky 获取你帖子的签名副本，由合约自己校验签名，无需信任我们。",
  "Watching for your post. This continues by itself once it appears, and your tTARI is collected automatically when it's due.": "正在等待你的帖子。出现后会自动继续，到期时 tTARI 会自动领取。",
  "I've posted it. Verify and claim": "我已发布，验证并领取",
  "Safety window": "安全期",
  "All clear.": "一切正常。",
  "Small payments skip this. Larger ones wait a short while first.": "小额付款没有安全期，大额的需要先等一会儿。",
  "It's ready.": "可以领取了。",
  "Your tTARI lands in your Skydrop wallet.": "你的 tTARI 会进入你的 Skydrop 钱包。",
  "Verifying…": "验证中…",
  "Collecting…": "领取中…",
  "Verified on-chain": "链上验证通过",
  "Looking for your post on Bluesky": "正在 Bluesky 上查找你的帖子",
  "Fetching the signed copy of your post": "正在获取帖子的签名副本",
  "Submitting the proof. The contract checks every signature itself": "正在提交证明，合约会自己校验每个签名",
  "Network fees are covered for you": "网络手续费已为你支付",
  "Network fees are covered. You don't need any tTARI to collect.": "网络手续费已覆盖，领取不需要任何 tTARI。",
  "We found your post. Press Verify to continue.": "找到你的帖子了，点击验证继续。",
  "We couldn't find a post containing your code yet. Post it publicly, wait a few seconds, then try again.": "还没找到包含你的口令的帖子。请公开发布，等几秒再试。",
  "You need a little tTARI for network fees first.": "需要先有一点 tTARI 作为网络手续费。",
  "Collected!": "领取成功！",
  "It's in your Skydrop wallet now.": "已经进入你的 Skydrop 钱包。",
  Delivered: "已送达",
  "Open wallet": "打开钱包",
  "Send some to a friend": "转给朋友一些",
  "Send to this account": "发给这个账号",
  "When someone sends tTARI to this account it shows up here. Want to try it? Send some to yourself.": "有人给这个账号发 tTARI 时会显示在这里。想试试吗？给自己发一点。",
  "The network is catching up to your claim. Trying again in a few seconds…": "网络正在追上你的领取，几秒后重试…",
  "Another wallet has started a claim on this account. If that isn't you, the real owner can cancel it. You can still start your own claim below.": "另一个钱包已对这个账号发起领取。如果不是你，真正的主人可以取消。你仍可以在下面发起自己的领取。",
  "The sender asked for something specific:": "发送者提出了指定内容：",
  // sends
  "Nothing waiting": "没有待领取的",
  "Anything you send that nobody has collected yet shows up here, and you can take it back after its refund time.": "你发出但还没人领取的资金会显示在这里，退款时间到后可以取回。",
  "Send some": "去发送",
  "Take it back": "取回",
  "Taking it back…": "取回中…",
  "Instant collect": "即时领取",
  "Nobody has collected this. You can take it back now.": "还没有人领取，你现在可以取回。",
  "Remind them": "提醒对方",
  "Open claim page": "打开领取页",
  "Everything this wallet has put in escrow that nobody has collected yet.": "这个钱包托管中、尚未被领取的全部资金。",
  // wallet modal
  "Your Skydrop wallet": "你的 Skydrop 钱包",
  "Kept in this browser. It signs for you, so you never connect an extension.": "保存在这个浏览器里，由它替你签名，无需连接任何插件。",
  Balance: "余额",
  "Your address (share it to receive tTARI)": "你的地址（分享给对方即可收款）",
  Withdraw: "提现",
  "Send tTARI out of Skydrop to any Tari address, such as your Sapient wallet.": "把 tTARI 从 Skydrop 转到任意 Tari 地址，比如你的 Sapient 钱包。",
  "Address to withdraw to": "提现地址",
  "Amount to withdraw": "提现金额",
  "Withdrawing…": "提现中…",
  "There isn't enough here to cover the network fee.": "余额不足以支付网络手续费。",
  "Prefer your own wallet?": "想用自己的钱包？",
  "Connect Sapient": "连接 Sapient",
  "Sapient wallet": "Sapient 钱包",
  "Sapient is a Tari browser wallet. Your keys stay in the extension and you approve each transaction there.": "Sapient 是 Tari 的浏览器钱包。密钥留在插件里，每笔交易都在那里确认。",
  "Sapient isn't installed in this browser.": "这个浏览器没有安装 Sapient。",
  "Connected. Sapient holds your keys and asks you to approve each transaction.": "已连接。Sapient 保管你的密钥，每笔交易都需要你确认。",
  "Use Skydrop's built-in wallet instead": "改用 Skydrop 内置钱包",
  "Recovery key": "恢复密钥",
  Hide: "隐藏",
  Reveal: "显示",
  "Recovery key copied": "恢复密钥已复制",
  "Anyone with this key controls this wallet. Save it somewhere safe. If you clear your browser data without it, the wallet is gone.": "拿到这个密钥的人就能控制这个钱包。请妥善保存。如果清除浏览器数据时没有备份，钱包就丢失了。",
  "Use a different recovery key": "使用其他恢复密钥",
  "Paste a 32-character recovery key. This replaces the wallet in this browser.": "粘贴 32 位恢复密钥。这会替换当前浏览器中的钱包。",
  "Asking the faucet…": "正在向水龙头申请…",
  "Testnet tTARI received": "已收到测试币 tTARI",
  "The public testnet faucet is empty right now. Ask in the Tari community for some tTARI and give them your address above, or try again later.": "公共测试网水龙头暂时空了。可以在 Tari 社区里讨要一些 tTARI（把上面的地址给他们），或稍后再试。",
  "Couldn't start": "启动失败",
  "Try again": "重试",
  // how it works
  "Short version: the money sits in a smart contract that can check Bluesky's own signatures.": "简单说：资金放在一个智能合约里，这个合约能校验 Bluesky 自己的签名。",
  "You send.": "你发送。",
  "They post a code.": "对方发一个口令。",
  "The contract checks the math.": "合约验算。",
  "They collect.": "对方领取。",
  "The tTARI moves into an escrow contract, filed under the recipient's permanent Bluesky ID (not their handle, which can change hands).": "tTARI 进入托管合约，登记在收款人永久的 Bluesky ID 名下（而不是可能易主的用户名）。",
  "The code is a hash of their wallet's key, so the post can only ever pay out to the wallet that asked.": "口令是对方钱包密钥的哈希，所以这条帖子只能把钱付给发起领取的那个钱包。",
  "Bluesky accounts are cryptographic identities. The contract verifies the account's identity history, the signature on their repository and the path to the post. No server is asked.": "Bluesky 账号本身是密码学身份。合约会验证账号的身份历史、其数据仓库上的签名以及到这条帖子的路径，不需要询问任何服务器。",
  "After the safety window you chose, the escrow pays out to their wallet.": "过了你选的安全期，托管合约就把钱付给对方的钱包。",
  "What's the safety window for?": "安全期是做什么的？",
  "A proof can show an account's history is valid, but not that it's complete. If someone stole a Bluesky signing key and the real owner had already rotated it, the thief could present the old history. The window lets anyone submit the owner's rotation and cancel the claim. Small tips can skip it. Large transfers should use it.":
    "证明能说明账号历史有效，却不能说明它完整。如果有人偷了 Bluesky 签名密钥而真正的主人已经轮换过密钥，小偷可以拿出旧的历史。安全期让任何人都能提交主人的轮换记录来取消领取。小额打赏可以跳过，大额转账建议使用。",
  "What if nobody claims it?": "如果没人领取呢？",
  "What can't it do yet?": "目前有什么做不到？",
  "Only did:plc accounts work (almost everyone). Private payouts to a stealth address are planned. This is testnet.": "目前只支持 did:plc 账号（几乎所有人）。隐私收款（隐身地址）在计划中。现在是测试网。",
  "Is my wallet safe?": "我的钱包安全吗？",
  "It's created in your browser and never sent anywhere. Back up your recovery key from the wallet menu. This is testnet software.": "钱包在你的浏览器里创建，不会发送到任何地方。请在钱包菜单里备份恢复密钥。这是测试网软件。",
};

type Pattern = [RegExp, (m: RegExpMatchArray) => string];

const timeZh = (s: string): string =>
  s
    .replace(/^about (\d+) min$/, "约 $1 分钟")
    .replace(/^about ([\d.]+) hours$/, "约 $1 小时")
    .replace(/^about (\d+) days$/, "约 $1 天")
    .replace(/^right away$/, "马上");

const PATTERNS: Pattern[] = [
  [/^Send ([\d.,]*)\s?tTARI to @(.+)$/, (m) => `发送 ${m[1] ?? ""} tTARI 给 @${m[2]}`.replace("  ", " ")],
  [/^Withdraw ([\d.,]+) tTARI$/, (m) => `提现 ${m[1]} tTARI`],
  [/^Collect ([\d.,]+) tTARI$/, (m) => `领取 ${m[1]} tTARI`],
  [/^Sent ([\d.,]+) tTARI to (.+)$/, (m) => `已转出 ${m[1]} tTARI 到 ${m[2]}`],
  [/^Collected ([\d.,]+) tTARI\. The rest is still in its safety window\.$/, (m) => `已领取 ${m[1]} tTARI，其余仍在安全期内。`],
  [/^([\d.,]+) tTARI is back in your wallet$/, (m) => `${m[1]} tTARI 已退回你的钱包`],
  [/^([\d.,]+) tTARI is already waiting for @(.+)\.$/, (m) => `已有 ${m[1]} tTARI 在等 @${m[2]} 领取。`],
  [/^Waiting for @(.+)$/, (m) => `等待 @${m[1]} 领取`],
  [/^Nothing is waiting for @(.+) yet$/, (m) => `目前没有给 @${m[1]} 的待领取资金`],
  [/^safety window (.+)$/, (m) => `安全期 ${timeZh(m[1]!)}`],
  [/^Safety window (.+)$/, (m) => `安全期 ${timeZh(m[1]!)}`],
  [/^([\d.,]+) tTARI is now held on-chain for @(\S+)\. They can collect it as soon as they verify\.$/, (m) => `${m[1]} tTARI 已锁在链上，等 @${m[2]} 领取。对方验证后即可领取。`],
  [/^([\d.,]+) tTARI is now held on-chain for @(\S+)\. They can collect it after a safety window of (.+)\.$/, (m) => `${m[1]} tTARI 已锁在链上，等 @${m[2]} 领取。经过 ${timeZh(m[3]!)} 的安全期后可领取。`],
  [/^If they haven't collected it in (.+), you can take it back\.$/, (m) => `如果对方在 ${timeZh(m[1]!)} 内没有领取，你可以取回。`],
  [/^The sender can take it back after (.+)\.$/, (m) => `发送者在 ${timeZh(m[1]!)} 后可以取回。`],
  [/^Waiting for them to collect\. You can take it back in (.+)\.$/, (m) => `等待对方领取。${timeZh(m[1]!)} 后你可以取回。`],
  [/^You can withdraw up to ([\d.,]+) tTARI\. A small network fee stays behind\.$/, (m) => `最多可提现 ${m[1]} tTARI，会留下一小笔网络手续费。`],
  [/^You have ([\d.,]+) tTARI\. A small network fee is kept back, so the most you can send is$/, (m) => `你有 ${m[1]} tTARI。需要留一小笔网络手续费，所以最多可发送`],
  [/^Larger payments wait a bit so the real owner could stop a hijack\. Next release (.+)\.$/, (m) => `大额付款需要等一会儿，让真正的主人有机会阻止盗用。下次释放时间：${timeZh(m[1]!)}。`],
  [/^([\d.,]+) tTARI is ready now\. ([\d.,]+) tTARI more is still in its safety window\.$/, (m) => `${m[1]} tTARI 现在可以领取，另有 ${m[2]} tTARI 仍在安全期内。`],
  [/^The Skydrop bot \(@(\S+)\) mentions them on Bluesky within a few minutes\. Add a personal note of your own too, it's what gets noticed\.$/, (m) => `Skydrop 机器人（@${m[1]}）会在几分钟内在 Bluesky 上提醒对方。你也可以自己加一句留言，更容易被注意到。`],
  [/^Fund a budget once\. Then tip anyone by posting "(.+)"\.$/, (m) => `先充值一次额度，之后发帖「${m[1]}」就能打赏任何人。`],
  [/^No tip budget yet for @(.+)\. Fund one below\.$/, (m) => `@${m[1]} 还没有打赏额度，请在下面充值。`],
  [/^(.+) left in your tip budget for @(\S+)\. Up to (.+) per tip\.$/, (m) => `@${m[2]} 的打赏额度还剩 ${m[1]}，每笔最多 ${m[3]}。`],
  [/^Keep it under (\d+) bytes.*$/, (m) => `请控制在 ${m[1]} 字节以内（约 ${m[1]} 个英文字母，非拉丁文字更少）。`],
  [/^Your latest claim post has .*$/, () => "你最新的领取帖子里的口令和这个浏览器里的钱包不一致。请在正在验证的同一个浏览器里，发布本页显示的文字。"],
  [/^Your post is missing the sender's phrase “(.+)”\..*$/, (m) => `你的帖子缺少发送者指定的这句话「${m[1]}」，必须完全一致，包括大小写。`],
  [/^The sender asked for something specific: (.+)\. It leads the text below\..*$/, (m) => `发送者指定了一句话：${m[1]}。它已经放在下面文字的最前面。只有你的帖子里原样包含它，这笔资金才会释放。`],
  [/^· must post “(.+)”$/, (m) => `· 需要发布「${m[1]}」`],
  [/^about (\d+) min$/, (m) => `约 ${m[1]} 分钟`],
  [/^about ([\d.]+) hours$/, (m) => `约 ${m[1]} 小时`],
  [/^about (\d+) days$/, (m) => `约 ${m[1]} 天`],
];

function zh(raw: string): string | null {
  const lead = /^\s*/.exec(raw)![0];
  const trail = /\s*$/.exec(raw)![0];
  const t = raw.trim();
  if (!t) return null;
  const hit = ZH[t];
  if (hit !== undefined) return lead + hit + trail;
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(t);
    if (m) return lead + fn(m) + trail;
  }
  return null;
}

const SKIP = "code, pre, .codebox, input, textarea, script, style, .mono, [data-i18n-skip]";
const ATTRS = ["placeholder", "aria-label", "title"];

function translateNode(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const p = node.parentElement;
    if (!p || p.closest(SKIP)) return;
    const v = node.nodeValue ?? "";
    const out = zh(v);
    if (out !== null && out !== v) node.nodeValue = out;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (el.matches(SKIP)) {
    // placeholders on inputs still read better translated
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      const out = v ? zh(v) : null;
      if (out && out !== v) el.setAttribute(a, out);
    }
    return;
  }
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    const out = v ? zh(v) : null;
    if (out && out !== v) el.setAttribute(a, out);
  }
  el.childNodes.forEach(translateNode);
}

/** Starts translating the page into Chinese, now and whenever the app renders again. */
export function startChinese(root: HTMLElement = document.body): void {
  document.documentElement.lang = "zh-CN";
  translateNode(root);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") translateNode(r.target);
      r.addedNodes.forEach(translateNode);
    }
  }).observe(root, { childList: true, subtree: true, characterData: true });
}
