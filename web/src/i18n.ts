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
  // rewards home
  "My quests": "我的任务",
  "Show my rewards": "查看我的奖励",
  "Create a campaign": "创建活动",
  "Testnet · checked against signed data": "测试网 · 基于已签名数据核验",
  "Get rewarded for what you": "在 Bluesky 上，为你的",
  do: "行动",
  "on Bluesky.": "获得奖励",
  "on Bluesky": "",
  "Campaigns pay Tari for likes, reposts, replies and follows. Enter your handle to see what you can collect and what's left to do.": "活动会为点赞、转发、回复和关注支付 Tari。输入你的用户名，查看可以领取什么、还差什么。",
  "Browse open campaigns": "浏览进行中的活动",
  "· no wallet needed to look.": "· 浏览无需钱包。",
  "Three steps to your first reward": "三步拿到第一份奖励",
  "Pick a campaign": "选择活动",
  "Browse what's open, or open a link someone shared. You'll see exactly what it asks for and what it pays.": "浏览进行中的活动，或打开别人分享的链接。你会清楚看到它的要求和奖励。",
  "Do the steps": "完成步骤",
  "Like, repost, reply or follow on Bluesky as you normally would. Your progress updates when you come back.": "像平时一样在 Bluesky 上点赞、转发、回复或关注。回到这里时进度会自动更新。",
  "Post once and collect": "发一条帖子并领取",
  "One short post ties the reward to your wallet. Approve it in Sapient and it's yours.": "一条简短的帖子把奖励绑定到你的钱包。在 Sapient 中批准后即归你所有。",
  "No middleman": "没有中间人",
  "The contract checks your account's signatures itself, then pays you directly.": "合约自行核验你账户的签名，然后直接付款给你。",
  "Only you choose the wallet": "只有你能选择钱包",
  "Your one post names your wallet, so nobody can redirect your reward.": "你的帖子写明了你的钱包，所以没人能转走你的奖励。",
  "Free to check": "免费查看",
  "You only need a wallet to collect, and it pays a small network fee.": "只有领取时才需要钱包，并支付少量网络费用。",
  "Run a campaign": "发起活动",
  "Reward people for engaging with your posts. Build one in minutes on atproto.tari.mw.": "奖励与你的帖子互动的人。在 atproto.tari.mw 上几分钟就能创建。",
  "Gifts and tips": "礼物和打赏",
  "Sending Tari to any handle is coming back once its contracts are on the new network.": "向任意用户发送 Tari 的功能，会在合约部署到新网络后恢复。",
  "Gifts aren't running right now.": "礼物功能暂未运行。",
  "They're being moved to the new network, so nothing can be sent or collected here yet.": "它们正在迁移到新网络，所以目前这里还不能发送或领取。",
  "See your campaign rewards": "查看你的活动奖励",
  "Campaign rewards": "活动奖励",
  "Gifts, once they're back": "礼物功能（恢复后）",
  "A creator funds a campaign.": "创建者为活动注资。",
  "The reward pool is locked in a contract with fixed rules. They can't change the rules or take the money back before it closes.": "奖池锁定在规则固定的合约中。活动结束前，创建者不能修改规则或取回资金。",
  "You do the steps.": "你完成步骤。",
  "Your likes, reposts, replies and follows are signed records in your own Bluesky account.": "你的点赞、转发、回复和关注，都是你 Bluesky 账户中的已签名记录。",
  "You post one line.": "你发一条帖子。",
  "It names your wallet, so the reward can only go there.": "它写明了你的钱包，所以奖励只能发到那里。",
  "The contract checks it and pays.": "合约核验后付款。",
  "Your wallet sends the proofs and pays a small network fee. Each account can only collect once per round.": "你的钱包提交证明并支付少量网络费用。每个账户每轮只能领取一次。",
  "It can't tell when you did a step or whether you undo it later, and anyone can make new accounts, so open campaigns can be farmed. Creators can limit that with lists and vouches.": "它无法判断你何时完成步骤，也无法判断你之后是否撤销；任何人都能注册新账户，所以公开活动可能被刷。创建者可以用名单和担保来限制。",
  "See your rewards": "查看你的奖励",
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
  "All set": "一切就绪",
  "Nothing to collect": "没有需要领取的款项",
  "A gift with a challenge shows up here until its phrase is posted.": "带口令的礼物会显示在这里，直到发布了对应的话。",
  "Change linked wallet": "更换关联的钱包",
  "Link my wallet": "关联我的钱包",
  "When someone sends tTARI to this account it shows up here. Link a wallet once and future gifts arrive instantly.": "有人给这个账号发 tTARI 时会显示在这里。关联一次钱包，以后的礼物就会即时到账。",
  "Three steps, no wallet needed": "三步搞定，无需钱包",
  "You send": "你来发送",
  "Type a Bluesky handle, pick an amount and an envelope. The tTARI waits on-chain under their account.": "输入 Bluesky 账号，选择金额和红包封面。tTARI 会锁在链上，等对方领取。",
  "They get a mention": "对方收到提醒",
  "The Skydrop bot tells them on Bluesky, with your envelope and note.": "Skydrop 机器人会在 Bluesky 上通知对方，并带上你的红包和留言。",
  "They prove it's them": "对方证明身份",
  "One post from their account, checked by the contract itself. Link a wallet once and later gifts arrive instantly.": "用自己的账号发一条帖子，由合约自己验证。关联一次钱包，之后的礼物即时到账。",
  "Switch between light and dark": "切换浅色/深色模式",
  "What is a challenge?": "什么是口令？",
  "A sender can ask for something specific: a phrase the receiver has to post, and optionally that the post stays up for some hours. The contract checks it. To collect a challenge gift you link a wallet first (one post), then post the phrase in a separate, later post.": "发送者可以指定一句话，要求收款人发帖说出来，还可以要求帖子保留几个小时，由合约来检查。要领取带口令的礼物，需要先关联钱包（发一条帖子），然后再单独发一条帖子说出指定的话。",
  "Can I decline a gift?": "可以拒绝礼物吗？",
  "Yes, once your wallet is linked: open Collect, pick \"Decline a gift\" and sign from your wallet. The money goes back to the sender, who takes it back from Your sends. Phrase gifts nobody answers for about three days can be sent back by anyone.": "可以，关联钱包之后：打开「领取」，选择「拒绝礼物」，用你的钱包签名。款项会退回给发送者，对方在「我的发送」里取回。无人响应的口令礼物约三天后可由任何人退回。",
  "What if my Bluesky key was stolen?": "如果我的 Bluesky 密钥被盗了怎么办？",
  "A proof can't show an account's history is complete, so links and claims wait out a short delay during which anyone, and the Skydrop bot, can cancel them by showing the account's newer history. Larger gifts can add a longer safety window.": "证明无法说明账号的历史记录是完整的，所以关联和领取都要先经过一小段等待期，期间任何人（包括 Skydrop 机器人）都可以出示账号更新的历史记录来取消。大额礼物还可以设置更长的安全期。",
  "Not interested? Link your wallet first, then you can decline the gift and it goes back to the sender.": "不感兴趣？先关联钱包，之后就能拒绝这份礼物，款项会退回给发送者。",
  Refundable: "可取回",
  "Claim started": "已开始领取",
  "Needs a link": "需先关联",
  "Needs the phrase": "需发布口令",
  Waiting: "等待中",
  "Delivered instantly": "即时到账的礼物",
  "Paid straight to their linked wallet": "已直接发到对方关联的钱包",
  "Nothing is waiting. Everything you've sent has been delivered or collected.": "没有待领取的款项，你发出的都已送达或被领取。",
  "What this wallet has sent: gifts still waiting to be collected, and ones that were delivered instantly.": "这个钱包发出的礼物：尚未被领取的，以及即时到账的。",
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
  "Link wallet": "关联钱包",
  "Link your wallet": "关联你的钱包",
  "Link your wallet first": "请先关联你的钱包",
  "Step 1: link my wallet": "第 1 步：关联我的钱包",
  "Post the phrase": "发布指定的话",
  "Get paid": "收到款项",
  "Linked": "已关联",
  "Collect what's waiting": "领取待领取的款项",
  "Next: post the phrase": "下一步：发布指定的话",
  "Link a different address": "关联另一个地址",
  "Link a different account": "关联另一个账户",
  "Use this address": "使用这个地址",
  "Cancel": "取消",
  "Link it": "关联",
  "I've posted it. Link it": "我已发布，立即关联",
  "I've posted it. Link my wallet": "我已发布，关联我的钱包",
  "Add a challenge": "添加口令",
  "optional": "可选",
  "Linking this wallet.": "正在关联这个钱包。",
  "Confirm my post is still up": "确认我的帖子仍在",
  "Your post is confirmed": "帖子已确认",
  "No need to keep it up": "不需要保留帖子",
  "Link your wallet to your Bluesky account once. Gifts then land in it instantly, with nothing to claim.": "把钱包和你的 Bluesky 账号关联一次，之后收到的礼物会直接到账，无需领取。",
  "Tips arrive straight in your wallet": "打赏会直接到你的钱包",
  "Your wallet is linked, so the challenge post needs only the phrase below. Your money goes to your linked wallet.": "你的钱包已关联，所以口令帖子只需包含下面这句话。款项会进入你关联的钱包。",
  "Your wallet is linked. Post this as a new post from your account, separate from the link post, and the money goes to your linked wallet.": "你的钱包已关联。请用你的账号单独发一条新帖子（不要和关联帖子是同一条），款项就会进入你关联的钱包。",
  "It proves the account is yours. The code ties it to this address, so it can't link anyone else.": "这能证明账号是你的。口令和这个地址绑定，所以无法关联到别人。",
  "We watch for the post and link it for you. A tiny network fee comes from your wallet.": "我们会监测这条帖子并自动为你关联，只需从你的钱包扣一点点网络手续费。",
  "Steps": "步骤",
  "Needs a claim": "需要领取",
  "Change address": "更换地址",
  Settings: "设置",
  Language: "语言",
  Theme: "主题",
  Light: "浅色",
  Auto: "自动",
  "Not interested? Decline a gift": "不感兴趣？拒绝礼物",
  "Decline": "拒绝",
  "Declining…": "正在拒绝…",
  "Link first": "先关联",
  "Use your linked wallet": "请用关联的钱包操作",
  "Return expired gifts": "退回已过期的礼物",
  "Returned": "已退回",
  "Declined. It's on its way back to the sender.": "已拒绝，款项正在退回给发送者。",
  "Declining sends the gift back to the person who sent it. You do it from your linked wallet.": "拒绝会把礼物退回给发送者，需要用你关联的钱包操作。",
  "To decline a gift you link your wallet first (one post, once). Then you can send gifts back to their senders.": "要拒绝礼物，需要先关联钱包（发一条帖子，只需一次），之后就能把礼物退回给发送者。",
  "Gifts that were declined, or that nobody answered, are waiting for you.": "被拒绝或无人响应的礼物正在等你取回。",
  "Paste a Tari wallet address (it starts with otl_).": "请粘贴 Tari 钱包地址（以 otl_ 开头）。",
  "You already have several gifts waiting for this account. Wait until some are collected, then send again.": "你给这个账号的礼物已有好几份在等待领取。等部分被领取后再发送。",
  "This account already has several gifts waiting on a phrase. Send one without a phrase, or try again later.": "这个账号已有好几份带口令的礼物在等待。你可以发一份不带口令的，或稍后再试。",
  "This account has too many gifts waiting right now. Try again later.": "这个账号目前等待领取的礼物太多，请稍后再试。",
  "Link your wallet first, then you can decline gifts.": "请先关联你的钱包，之后才能拒绝礼物。",
  "That address isn't an ordinary Tari wallet account, so it can't be linked.": "这个地址不是普通的 Tari 钱包账户，无法关联。",
  "Nothing has expired yet. Unanswered phrase gifts can be returned after about three days.": "目前没有过期的礼物。无人响应的口令礼物约三天后可以退回。",
  "A claim for this account is in progress, so nothing can be returned right now.": "这个账号正在领取中，暂时无法退回。",
  "Nothing has been returned to you.": "目前没有退回给你的款项。",
  "Bluesky gave an older snapshot of your account than one already proven. Wait a moment and try again.": "Bluesky 给出的账号快照比已验证的更旧，请稍等片刻再试。",
  "This gift is too small to cover more free network fees. Your wallet needs a little tTARI for the fee.": "这份礼物太小，不够再抵扣免费网络手续费。你的钱包需要一点 tTARI 来付手续费。",
  "That link post was already used. Make a new post to link again.": "这条关联帖子已经用过了，请重新发一条帖子来关联。",
  "That gift is no longer there. It may already have been collected, declined or returned.": "这份礼物已经不在了，可能已被领取、拒绝或退回。",
  "Nothing is waiting for this account any more.": "这个账号已没有待领取的款项。",
  "This gift can't be taken back yet. Check Your sends for when.": "这份礼物暂时还不能取回，请在「我的发送」里查看时间。",
  "That link is already in effect.": "这个关联已经生效了。",
  "The free network fees for this account have been used. Your wallet needs a little tTARI for the fee.": "这个账号的免费网络手续费已用完。你的钱包需要一点 tTARI 来付手续费。",
};

type Pattern = [RegExp, (m: RegExpMatchArray) => string];

const timeZh = (s: string): string =>
  s
    .replace(/^about (\d+) min$/, "约 $1 分钟")
    .replace(/^about ([\d.]+) hours$/, "约 $1 小时")
    .replace(/^about (\d+) days$/, "约 $1 天")
    .replace(/^right away$/, "马上");

const PATTERNS: Pattern[] = [
  [/^@(\S+) has a linked wallet \((.+)\), so gifts land there directly\.$/, (m) => `@${m[1]} 已关联钱包（${m[2]}），礼物会直接发到那里。`],
  [/^(\S+) has started claiming this\. It's released when its safety window and any phrase are done\.$/, (m) => `${m[1]} 已开始领取。安全期和口令都完成后才会释放。`],
  [/^(\S+) must link a wallet first, then post “(.+)”(?: and keep it up for (.+))?\.$/, (m) => `${m[1]} 需要先关联钱包，然后发布「${m[2]}」${m[3] ? `并保留帖子 ${timeZh(m[3])}` : ""}。`],
  [/^(\S+) has linked a wallet\. Waiting for a post that says “(.+)”(?: and keep it up for (.+))?\.$/, (m) => `${m[1]} 已关联钱包，正在等待包含「${m[2]}」的帖子${m[3] ? `（并保留 ${timeZh(m[3])}）` : ""}。`],
  [/^Waiting for (\S+) to collect it\.$/, (m) => `等待 ${m[1]} 领取。`],
  [/^You can take it back in (.+)\.$/, (m) => `${timeZh(m[1]!)} 后你可以取回。`],
  [/^@(\S+) is currently linked to (\S+)\. Linking (.+) instead takes over after about one epoch; until then the old one keeps receiving\.$/, (m) => `@${m[1]} 目前关联的是 ${m[2]}。改为关联 ${m[3]} 约一个周期后生效，在此之前旧地址继续收款。`],
  [/^@(\S+) hasn't linked a wallet\. They collect your gift by proving they own the account\.$/, (m) => `@${m[1]} 还没有关联钱包。对方需要证明自己拥有该账号才能领取你的礼物。`],
  [/^@(\S+) has linked a wallet\. A gift with no safety window and no phrase arrives there immediately\.$/, (m) => `@${m[1]} 已关联钱包。没有安全期、没有口令的礼物会立即到账。`],
  [/^@(\S+) hasn't linked a wallet yet\. To collect a challenge gift they'll first link one \(one post\), then post your phrase\.$/, (m) => `@${m[1]} 还没有关联钱包。要领取带口令的礼物，对方需要先关联钱包（发一条帖子），再发布你指定的话。`],
  [/^([\d.,]+) tTARI went straight to @(\S+)'s linked wallet\.$/, (m) => `${m[1]} tTARI 已直接发到 @${m[2]} 关联的钱包。`],
  [/^@(\S+) is linked to (.+)\. Gifts with no safety window and no phrase are paid there the moment they are sent\. Anything with a challenge is released when you post its phrase in a new post, and paid there too\.$/, (m) => `@${m[1]} 已关联到 ${m[2]}。没有安全期、没有口令的礼物发出即到账；带口令的礼物在你用新帖子发布对应的话后释放，同样发到那里。`],
  [/^Linking (.+)\.$/, (m) => `正在关联 ${m[1]}。`],
  [/^Must stay up for (.+)$/, (m) => `帖子需保留 ${timeZh(m[1]!)}`],
  [/^Link submitted\. (.+) takes over from the old address after about one epoch\.$/, (m) => `已提交关联。约一个周期后，${m[1]} 将取代旧地址。`],
  [/^([\d.,]+) tTARI comes with a challenge from the sender\..*$/, (m) => `${m[1]} tTARI 附带发送者的口令。要领取，请先关联钱包（发一条帖子，只需一次），然后单独发布指定的话。两件事不能放在同一条帖子里。`],
  [/^Step 1 of 3\. Link your wallet once with a Bluesky post\..*$/, () => "第 1 步（共 3 步）：用一条 Bluesky 帖子关联你的钱包。之后发布发送者指定的话，款项就会进入这个钱包。"],

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
