/* UI copy only. Names, cards, room codes and user text are never scanned. */
(() => {
  'use strict';

  const STORAGE_KEY = 'poker-language';
  const LANGUAGES = new Set(['zh-CN', 'zh-TW', 'en']);
  // Each row is [Simplified Chinese source key, Traditional Chinese, English].
  const entries = [
    ['底池实验室 · 联机牌桌', '底池實驗室 · 線上牌桌', 'Pot Lab · Online Poker'],
    ['底池实验室', '底池實驗室', 'Pot Lab'],
    ['联机德州扑克', '線上德州撲克', 'Online Texas Hold’em'],
    ['和朋友联机打德州扑克。输入昵称与房间号即可入场或观战。', '與朋友線上玩德州撲克。輸入暱稱和房間號碼即可入座或觀戰。', 'Play Texas Hold’em with friends. Enter a nickname and room code to sit or watch.'],
    ['准备连接', '準備連線', 'Connecting…'],
    ['私人联机牌桌', '私人線上牌桌', 'Private online table'],
    ['开一桌，或者加入朋友的牌局', '開一桌，或加入朋友的牌局', 'Start a table or join friends'],
    ['无需注册。输入昵称后，可自由选座，也可以一直观战。', '無需註冊。輸入暱稱後，可自由選座，也能一直觀戰。', 'No signup. Enter a nickname, choose a seat, or keep watching.'],
    ['进入方式', '進入方式', 'How to enter'],
    ['开设房间', '開設房間', 'Create room'],
    ['加入房间', '加入房間', 'Join room'],
    ['你的昵称', '你的暱稱', 'Your nickname'],
    ['例如：阿河', '例如：阿河', 'For example: Alex'],
    ['房间号', '房間號碼', 'Room code'],
    ['输入 4–8 位房间号', '輸入 4–8 位房間號碼', 'Enter a 4–8 digit code'],
    ['恢复码（可选）', '恢復碼（選填）', 'Recovery code (optional)'],
    ['换了网址，用它认回原座', '換了網址，可用它取回原座位', 'Use this to recover your seat after the URL changes'],
    ['恢复码是本房间的身份凭证，不要发给其他人。', '恢復碼是本房間的身分憑證，請勿分享給其他人。', 'Your recovery code identifies you in this room. Keep it private.'],
    ['牌桌人数', '牌桌人數', 'Table size'],
    ['4 人', '4 人', '4 players'],
    ['5 人', '5 人', '5 players'],
    ['6 人', '6 人', '6 players'],
    ['7 人', '7 人', '7 players'],
    ['8 人', '8 人', '8 players'],
    ['9 人', '9 人', '9 players'],
    ['10 人', '10 人', '10 players'],
    ['直接观战', '直接觀戰', 'Watch instead'],
    ['盲注 10 / 20 · 牌局用独立牌组随机发牌 · 不含电脑玩家', '盲注 10 / 20 · 使用獨立牌組隨機發牌 · 無電腦玩家', 'Blinds 10 / 20 · Independently shuffled deck · No bots'],
    ['默认盲注 10 / 20 · 牌局用独立牌组随机发牌 · 不含电脑玩家', '預設盲注 10 / 20 · 使用獨立牌組隨機發牌 · 無電腦玩家', 'Default blinds 10 / 20 · Independently shuffled deck · No bots'],
    ['盲注 {small} / {big}', '盲注 {small} / {big}', 'Blinds {small} / {big}'],
    ['联机牌桌', '線上牌桌', 'Online table'],
    ['等待开局', '等待開局', 'Waiting to start'],
    ['盲注 10 / 20', '盲注 10 / 20', 'Blinds 10 / 20'],
    ['德州扑克牌桌', '德州撲克牌桌', 'Texas Hold’em table'],
    ['底池 0', '底池 0', 'Pot 0'],
    ['公共牌', '公共牌', 'Community cards'],
    ['等待发牌', '等待發牌', 'Waiting for cards'],
    ['协商时胜率', '協商時勝率', 'Equity at the vote'],
    ['送礼物', '送禮物', 'Send gift'],
    ['牌局操作', '牌局操作', 'Poker actions'],
    ['两次跑马牌面', '兩次跑馬牌面', 'Run it twice boards'],
    ['座位与筹码', '座位與籌碼', 'Seats and chips'],
    ['房间信息', '房間資訊', 'Room details'],
    ['当前房间', '目前房間', 'Current room'],
    ['复制房间号', '複製房間號碼', 'Copy room code'],
    ['复制邀请链接', '複製邀請連結', 'Copy invite link'],
    ['返回大厅', '返回大廳', 'Back to lobby'],
    ['复制我的恢复码', '複製我的恢復碼', 'Copy my recovery code'],
    ['无法复制？手动查看', '無法複製？手動查看', 'Can’t copy? Show code'],
    ['我的恢复码', '我的恢復碼', 'My recovery code'],
    ['换了网址，用它认回原座。恢复码相当于本房间身份凭证，请勿转发。', '換了網址，可用它取回原座位。恢復碼是本房間的身分憑證，請勿轉傳。', 'Use this code to recover your seat if the URL changes. Keep it private.'],
    ['切换玩家', '切換玩家', 'Switch player'],
    ['切换会先离开当前座位；请先保存旧身份的恢复码。', '切換前會離開目前座位；請先保存舊身分的恢復碼。', 'Switching leaves your current seat. Save its recovery code first.'],
    ['按需查看', '按需查看', 'Show when needed'],
    ['补码与总盈亏', '補碼與總盈虧', 'Rebuys and profit'],
    ['发牌公开记录', '發牌公開紀錄', 'Dealing record'],
    ['随机牌堆信息', '隨機牌堆資訊', 'Shuffle details'],
    ['语言', '語言', 'Language'],
    ['金额显示', '金額顯示', 'Amounts'],
    ['筹码', '籌碼', 'Chips'],
    ['入座', '入座', 'Sit down'],
    ['选择一个空位', '選擇一個空位', 'Choose an open seat'],
    ['关闭入座面板', '關閉入座面板', 'Close seat panel'],
    ['带入筹码', '帶入籌碼', 'Buy-in chips'],
    ['补码金额', '補碼金額', 'Rebuy amount'],
    ['坐下后可补入 2,000 筹码。', '入座後可補入 2,000 籌碼。', 'You can rebuy 2,000 chips after sitting.'],
    ['给朋友一点心意', '給朋友一點心意', 'A little something for a friend'],
    ['关闭礼物面板', '關閉禮物面板', 'Close gift panel'],
    ['玫瑰花束', '玫瑰花束', 'Rose bouquet'],
    ['50 筹码 / 束', '每束 50 籌碼', '50 chips / bouquet'],
    ['玫瑰颜色', '玫瑰顏色', 'Rose color'],
    ['白玫瑰', '白玫瑰', 'White rose'],
    ['红玫瑰', '紅玫瑰', 'Red rose'],
    ['送给', '送給', 'To'],
    ['花束接收者', '花束接收者', 'Gift recipient'],
    ['花束数量', '花束數量', 'Bouquet count'],
    ['1 束', '1 束', '1 bouquet'],
    ['9 束', '9 束', '9 bouquets'],
    ['99 束', '99 束', '99 bouquets'],
    ['自定义', '自訂', 'Custom'],
    ['合计', '合計', 'Total'],
    ['50 筹码', '50 籌碼', '50 chips'],
    ['送出花束', '送出花束', 'Send bouquet'],
    ['悄悄地进村', '悄悄地進村', 'Sneak into town'],
    ['免费 · 全房间可见', '免費 · 全房間可見', 'Free · visible to the room'],
    ['发送暗号', '發送暗號', 'Send secret phrase'],
    ['我的赠礼记录', '我的贈禮紀錄', 'My gift activity'],

    // Common client-rendered labels. Keys match the Simplified source strings.
    ['{name} · {seat} 号位', '{name} · {seat} 號位', '{name} · Seat {seat}'],
    ['{amount} 筹码', '{amount} 籌碼', '{amount} chips'],
    ['底池 {amount}', '底池 {amount}', 'Pot {amount}'],
    ['第 {handNo} 手', '第 {handNo} 手', 'Hand {handNo}'],
    ['第 {index} 次牌面', '第 {index} 次牌面', 'Board {index}'],
    ['暂离 {count}/5 手', '暫離 {count}/5 手', 'Away {count}/5'],
    ['净赢 +{amount}', '淨贏 +{amount}', 'Net +{amount}'],
    ['净赢 0', '淨贏 0', 'Net 0'],
    ['净亏 −{amount}', '淨虧 −{amount}', 'Net −{amount}'],
    ['分得 {amount}', '分得 {amount}', 'Won {amount}'],
    ['本轮投入 {amount}', '本輪投入 {amount}', 'This round {amount}'],
    ['本手待结算：{items}', '本手待結算：{items}', 'Settles after hand: {items}'],
    ['已送出 {quantity} 束花。', '已送出 {quantity} 束花。', 'Sent {quantity} bouquets.'],
    ['{name} 送给 {recipient} ×{quantity}，{amount} 筹码', '{name} 送給 {recipient} ×{quantity}，{amount} 籌碼', '{name} → {recipient} ×{quantity}, {amount} chips'],
    ['暂离', '暫離', 'Away'],
    ['下手暂离', '下手暫離', 'Away next'],
    ['下一手参与', '下一手參與', 'Next hand'],
    ['弃牌', '棄牌', 'Fold'],
    ['过牌', '過牌', 'Check'],
    ['跟注', '跟注', 'Call'],
    ['加注', '加注', 'Raise'],
    ['加注至 {amount}', '加注至 {amount}', 'Raise to {amount}'],
    ['全下', '全下', 'All-in'],
    ['返回牌桌', '返回牌桌', 'Return'],
    ['离座', '離座', 'Leave seat'],
    ['翻牌前', '翻牌前', 'Preflop'],
    ['翻牌', '翻牌', 'Flop'],
    ['转牌', '轉牌', 'Turn'],
    ['河牌', '河牌', 'River'],
    ['高牌', '高牌', 'High card'],
    ['一对', '一對', 'Pair'],
    ['两对', '兩對', 'Two pair'],
    ['两队', '兩對', 'Two pair'],
    ['三条', '三條', 'Three of a kind'],
    ['顺子', '順子', 'Straight'],
    ['同花', '同花', 'Flush'],
    ['葫芦', '葫蘆', 'Full house'],
    ['四条', '四條', 'Four of a kind'],
    ['同花顺', '同花順', 'Straight flush']
    ,['{name} 致 {recipient}', '{name} 致 {recipient}', '{name} to {recipient}']
    ,['{name}，座位 {seat}', '{name}，座位 {seat}', '{name}, seat {seat}']
    ,['{occupied} / {capacity} 人已入座', '已入座 {occupied} / {capacity} 人', '{occupied} / {capacity} seated']
    ,['{seat} 号位', '{seat} 號位', 'Seat {seat}']
    ,['{seat} 号空位', '{seat} 號空位', 'Seat {seat} open']
    ,['×{quantity} · {amount} 筹码', '×{quantity} · {amount} 籌碼', '×{quantity} · {amount} chips']
    ,['×{quantity} 束 · {amount} 筹码', '×{quantity} 束 · {amount} 籌碼', '×{quantity} bouquets · {amount} chips']
    ,['下手参与', '下手參與', 'Next hand']
    ,['下手将暂离', '下手將暫離', 'Away next']
    ,['亮出我的牌', '亮出我的牌', 'Show my cards']
    ,['你的手牌已公开。', '你的底牌已公開。', 'Your cards are shown.']
    ,['像素🥹表情', '像素🥹表情', 'Pixel pleading face']
    ,['先填入全下金额，再点{verb}确认', '先填入全下金額，再按「{verb}」確認', 'Fill the all-in amount, then tap {verb}.']
    ,['入座后可送花；暗号可免费发送。', '入座後可送花；暗號可免費發送。', 'Sit to send roses. The secret phrase is free.']
    ,['决定是否跑两次', '決定是否跑兩次', 'Run it twice?']
    ,['切换玩家失败。', '切換玩家失敗。', 'Could not switch player.']
    ,['即将翻第 2 次牌面', '即將翻出第 2 次牌面', 'Second board coming up']
    ,['卸码取消 {count} 次', '取消卸碼 {count} 次', '{count} cash-out(s) canceled']
    ,['发一次', '發一次', 'Run once']
    ,['发两次', '發兩次', 'Run twice']
    ,['只跑一次', '只跑一次', 'Run once']
    ,['可免费过牌', '可以免費過牌', 'Check for free']
    ,['同意跑两次', '同意跑兩次', 'Run twice']
    ,['坐到 {seat} 号位', '坐到 {seat} 號位', 'Sit at seat {seat}']
    ,['全押', '全押', 'ALL-IN']
    ,['已入座；本手不参与，从下一手开始发牌。', '已入座；本手不參與，下一手起發牌。', 'Seated. You join from the next hand.']
    ,['已全下，等待落后方选择跑马次数。', '已全下，等待落後方選擇跑馬次數。', 'All-in. Waiting for the trailing player.']
    ,['已切换身份。输入新昵称即可加入；旧身份可凭恢复码找回。', '已切換身分。輸入新暱稱即可加入；舊身分可用恢復碼取回。', 'Player switched. Enter a new nickname; use the old recovery code to return.']
    ,['已弃牌', '已棄牌', 'Folded']
    ,['已暂时离席；从下一手起不发牌。', '已暫時離席；下一手起不發牌。', 'Sitting out from the next hand.']
    ,['已返回牌桌；连续暂离计数已清零，从下一手起参与。', '已返回牌桌；連續暫離次數已清零，下一手起參與。', 'Back at the table. Away count reset; join next hand.']
    ,['座位 {seat}', '座位 {seat}', 'Seat {seat}']
    ,['当前玩家行动进度', '目前玩家行動進度', 'Current player’s turn timer']
    ,['待结算', '待結算', 'Pending']
    ,['我的牌型', '我的牌型', 'My hand']
    ,['房间号须为 4–8 位数字。', '房間號碼須為 4–8 位數字。', 'Room code must have 4–8 digits.']
    ,['手末结算', '手末結算', 'Settles after hand']
    ,['打枪的不要', '打槍的不要', 'Don’t fire a shot']
    ,['操作未完成。', '操作未完成。', 'Action not completed.']
    ,['操作未完成，请重试。', '操作未完成，請重試。', 'Action not completed. Try again.']
    ,['收手吧Kelly', '收手吧Kelly', 'Time to stop, Kelly']
    ,['收手吧Kelly🥹', '收手吧Kelly🥹', 'Time to stop, Kelly 🥹']
    ,['昵称最多 18 个字符。', '暱稱最多 18 個字元。', 'Nickname may have up to 18 characters.']
    ,['暂离 {count}/5', '暫離 {count}/5', 'Away {count}/5']
    ,['暗号已发送。', '暗號已發送。', 'Secret phrase sent.']
    ,['暗牌', '暗牌', 'Face-down card']
    ,['最低加注至 {amount}。', '至少加注至 {amount}。', 'Raise to at least {amount}.']
    ,['最多加注至 {amount}。', '最多加注至 {amount}。', 'Raise to at most {amount}.']
    ,['未翻出的公共牌', '未翻出的公共牌', 'Unrevealed community card']
    ,['未获取到房间号，请重试。', '未取得房間號碼，請重試。', 'Could not get a room code. Try again.']
    ,['本房间礼物演出中，请稍后再送。', '本房間正在展示禮物，請稍後再送。', 'Gift animation is playing. Try again shortly.']
    ,['本手只能全下至 {amount}。', '本手只能全下至 {amount}。', 'Only an all-in to {amount} is available.']
    ,['本手结果', '本手結果', 'Hand result']
    ,['本手跑马已暂停，请房主检查本机服务。', '本手跑馬已暫停，請房主檢查本機服務。', 'Runout paused. Ask the host to check the server.']
    ,['本手进行中，请在结算后切换玩家。', '本手進行中，請在結算後切換玩家。', 'Switch players after this hand settles.']
    ,['本板赢家', '本板贏家', 'Board winner']
    ,['本轮', '本輪', 'Round']
    ,['欢迎可可姐', '歡迎可可姐', 'Welcome, Kelly']
    ,['正在翻第 {index} 次牌面。', '正在翻出第 {index} 次牌面。', 'Dealing board {index}.']
    ,['此设备已保存「{name}」的身份；进入后将恢复原玩家。需要换人时，请进房后点击“切换玩家”。', '此裝置已儲存「{name}」的身分；進入後會恢復原玩家。要換人，請進房後按「切換玩家」。', 'This device saved {name}. Joining restores that player. To change, use Switch player in the room.']
    ,['此设备已保存一位玩家的身份；进入后将恢复原玩家。需要换人时，请进房后点击“切换玩家”。', '此裝置已儲存一位玩家的身分；進入後會恢復原玩家。要換人，請進房後按「切換玩家」。', 'This device saved a player. Joining restores them. To change, use Switch player in the room.']
    ,['牌局进行中。', '牌局進行中。', 'Hand in progress.']
    ,['牌面已揭完', '牌面已全部翻出', 'Board complete']
    ,['玩家', '玩家', 'Player']
    ,['环绕牌桌的玩家与空位', '牌桌周圍的玩家與空位', 'Players and open seats around the table']
    ,['确认入座', '確認入座', 'Sit down']
    ,['礼物展示中', '禮物展示中', 'Gift animation']
    ,['空位', '空位', 'Open']
    ,['立即开始牌局', '立即開牌', 'Start hand now']
    ,['第 1 次牌面已定，正在准备第 2 次牌面。', '第 1 次牌面已定，正在準備第 2 次牌面。', 'First board complete. Preparing the second.']
    ,['第 1 次牌面已揭完', '第 1 次牌面已全部翻出', 'First board complete']
    ,['第 {handNo} 手：', '第 {handNo} 手：', 'Hand {handNo}: ']
    ,['第 {index} / 2 次牌面', '第 {index} / 2 次牌面', 'Board {index} of 2']
    ,['第 {index} 次{street}', '第 {index} 次{street}', 'Board {index} · {street}']
    ,['等另一位玩家入座后即可送花。', '等另一位玩家入座後即可送花。', 'Wait for another player to sit.']
    ,['等待玩家坐下开局。', '等待玩家入座開牌。', 'Waiting for players to sit.']
    ,['等待落后方选择一次或两次。', '等待落後方選擇一次或兩次。', 'Waiting for the trailing player to choose.']
    ,['等待领先方决定。', '等待領先方決定。', 'Waiting for the leading player.']
    ,['等待领先方决定是否跑两次。', '等待領先方決定是否跑兩次。', 'Waiting for the leading player to decide.']
    ,['筹码 {amount}', '籌碼 {amount}', 'Stack {amount}']
    ,['自动补码 {amount}', '自動補碼 {amount}', 'Auto rebuy {amount}']
    ,['补码待入账', '補碼待入帳', 'Rebuy pending']
    ,['请求失败（{status}）', '請求失敗（{status}）', 'Request failed ({status})']
    ,['请输入 1–20,000 束，合计最多 1,000,000 筹码。', '請輸入 1–20,000 束，合計最多 1,000,000 籌碼。', 'Enter 1–20,000 bouquets, up to 1,000,000 chips.']
    ,['请输入昵称。', '請輸入暱稱。', 'Enter a nickname.']
    ,['请输入有效筹码数。', '請輸入有效籌碼數。', 'Enter a valid chip amount.']
    ,['跑马{street}', '跑馬{street}', 'Runout · {street}']
    ,['跑马已暂停', '跑馬已暫停', 'Runout paused']
    ,['跑马投票中 · 尚未翻公共牌', '跑馬投票中 · 尚未翻公共牌', 'Runout vote · no board yet']
    ,['跑马牌面', '跑馬牌面', 'Runout board']
    ,['跟注 {amount}', '跟注 {amount}', 'Call {amount}']
    ,['轮到 {name} 行动。', '輪到 {name} 行動。', '{name} to act.']
    ,['轮到你行动', '輪到你行動', 'Your turn']
    ,['轮到你行动。', '輪到你行動。', 'Your turn.']
    ,['输入{verb}筹码数', '輸入{verb}籌碼數', 'Enter amount to {verb}']
    ,['输入{verb}BB数', '輸入{verb}的 BB 數量', 'Enter BB amount to {verb}']
    ,['还没有赠礼记录。', '還沒有贈禮紀錄。', 'No gifts yet.']
    ,['进入房间失败，请重试。', '進入房間失敗，請重試。', 'Could not join the room. Try again.']
    ,['连续暂离 5 手，已自动转为观战；可重新选座。', '連續暫離 5 手，已自動轉為觀戰；可重新選座。', 'Sat out five hands and moved to watching. Choose a seat to return.']
    ,['选择 {seat} 号空位', '選擇 {seat} 號空位', 'Choose open seat {seat}']
    ,['选择跑马次数', '選擇跑馬次數', 'Choose runouts']
    ,['需跟注 {amount}', '需跟注 {amount}', 'To call {amount}']
    ,['须高于当前下注 {amount}。', '須高於目前下注 {amount}。', 'Must exceed current bet {amount}.']
    ,['（待结算）', '（待結算）', '(pending)']
    ,['＋ 入座', '＋ 入座', '+ Sit']
    ,['{count} 人', '{count} 人', '{count} players']
    ,['{count} 张', '{count} 張', '{count} cards']
    ,['{label} {amount}', '{label} {amount}', '{label} {amount}']
    ,['你的状态', '你的狀態', 'Your status']
    ,['你的筹码', '你的籌碼', 'Your stack']
    ,['卸码 2,000', '卸碼 2,000', 'Cash out 2,000']
    ,['发牌承诺已复制。', '發牌承諾已複製。', 'Deck commitment copied.']
    ,['发牌时间（UTC）', '發牌時間（UTC）', 'Dealt at (UTC)']
    ,['可用筹码不足 2,000', '可用籌碼不足 2,000', 'Fewer than 2,000 chips available']
    ,['复制', '複製', 'Copy']
    ,['复制失败，可展开“手动查看”选择恢复码。', '複製失敗，可展開「手動查看」選取恢復碼。', 'Copy failed. Open Show code to select your recovery code.']
    ,['已公开牌的证明', '已公開牌的證明', 'Proofs for revealed cards']
    ,['已填入全下金额 {amount}；点“{verb}”确认。', '已填入全下金額 {amount}；按「{verb}」確認。', 'All-in amount {amount} filled. Tap {verb} to confirm.']
    ,['已带走 {amount}', '已帶走 {amount}', 'Cashed out {amount}']
    ,['带入 {buyIn} · 补码 {count} 次 / {rebuy}', '帶入 {buyIn} · 補碼 {count} 次 / {rebuy}', 'Buy-in {buyIn} · {count} rebuys / {rebuy}']
    ,['带入筹码须为至少 20 的整数。', '帶入籌碼須為至少 20 的整數。', 'Buy-in must be a whole number of at least 20 chips.']
    ,['座位', '座位', 'Seats']
    ,['当前 {amount}', '目前 {amount}', 'Now {amount}']
    ,['恢复码已复制，请仅自己保存。', '恢復碼已複製，請只供自己保存。', 'Recovery code copied. Keep it private.']
    ,['房间号已复制。', '房間號碼已複製。', 'Room code copied.']
    ,['暂无筹码记录。', '目前沒有籌碼紀錄。', 'No chip records yet.']
    ,['本房间还没有发牌记录。', '本房間尚無發牌紀錄。', 'No hands have been dealt in this room yet.']
    ,['本手结束后可切换玩家', '本手結束後可切換玩家', 'Switch after this hand']
    ,['本手结算后才能离座', '本手結算後才能離座', 'Leave after this hand settles']
    ,['每手由 UTC 时间和系统加密随机数生成独立牌堆。承诺与证明可核对已公开牌和开局牌堆的一致性，不能单凭它们证明随机源绝对不可操纵。', '每手由 UTC 時間與系統加密亂數產生獨立牌堆。承諾與證明可核對已公開牌和開局牌堆的一致性，不能僅憑它們證明亂數來源絕對未受操控。', 'Each hand uses an independent deck derived from UTC time and secure random bytes. Commitments and proofs verify revealed cards against the starting deck; they do not prove the random source cannot be manipulated.']
    ,['牌堆承诺', '牌堆承諾', 'Deck commitment']
    ,['盲注', '盲注', 'Blinds']
    ,['确定', '確定', 'Apply']
    ,['礼物净额 {amount}', '禮物淨額 {amount}', 'Gift net {amount}']
    ,['礼物展示结束后可切换玩家', '禮物展示結束後可切換玩家', 'Switch after gift animation']
    ,['离开座位', '離開座位', 'Leave seat']
    ,['种子承诺', '種子承諾', 'Seed commitment']
    ,['补码 2,000', '補碼 2,000', 'Rebuy 2,000']
    ,['观战人数', '觀戰人數', 'Spectators']
    ,['调整牌桌人数', '調整牌桌人數', 'Change table size']
    ,['调整大盲（筹码）', '調整大盲（籌碼）', 'Big blind (chips)']
    ,['大盲须为 2 至 1,000,000 的整数。', '大盲須為 2 至 1,000,000 的整數。', 'Big blind must be an integer from 2 to 1,000,000.']
    ,['带入筹码须为 {min} 至 1,000,000 的整数。', '帶入籌碼須為 {min} 至 1,000,000 的整數。', 'Buy-in must be an integer from {min} to 1,000,000.']
    ,['送花 {sent} · 收花 {received}', '送花 {sent} · 收花 {received}', 'Gifts sent {sent} · received {received}']
    ,['邀请链接已复制。', '邀請連結已複製。', 'Invite link copied.']
    ,['1/2池', '1/2 池', '1/2 pot']
    ,['1/3池', '1/3 池', '1/3 pot']
    ,['1倍池', '1 倍池', 'Pot']
    ,['{name} 送给 {recipient} ×{quantity}，{amount} 筹码，手末结算', '{name} 送給 {recipient} ×{quantity}，{amount} 籌碼，本手結束後結算', '{name} → {recipient} ×{quantity}, {amount} chips; settles after hand']
    ,['{quantity} 束花已展示，本手结束统一结算。', '已展示 {quantity} 束花，本手結束後一併結算。', '{quantity} bouquets shown. They settle after this hand.']
    ,['加码', '加碼', 'bet']
    ,['估计胜率', '估計勝率', 'Estimated equity']
    ,['入座后可随时补码。', '入座後可隨時補碼。', 'You can rebuy after sitting.']
    ,['加注至', '加注至', 'Raise to']
    ,['卸码', '卸碼', 'Cash out']
    ,['卸码 2,000 已排队，本手结束结算。', '卸碼 2,000 已排隊，本手結束後結算。', 'Cash-out of 2,000 queued until this hand ends.']
    ,['在座', '在座', 'Seated']
    ,['实时在线', '即時在線', 'Online']
    ,['已加注', '已加注', 'Raised']
    ,['已卸码 2,000。', '已卸碼 2,000。', 'Cashed out 2,000.']
    ,['已补码 2,000。', '已補碼 2,000。', 'Rebought 2,000.']
    ,['已记录', '已記錄', 'Recorded']
    ,['已跟注', '已跟注', 'Called']
    ,['已转为观战', '已轉為觀戰', 'Now watching']
    ,['已过牌', '已過牌', 'Checked']
    ,['开房并观战', '開房並觀戰', 'Create and watch']
    ,['待翻牌', '等待翻牌', 'Board coming']
    ,['摊牌', '攤牌', 'Showdown']
    ,['收礼', '收禮', 'Gifts in']
    ,['暂时无法连接房间，请稍后刷新。', '暫時無法連線房間，請稍後重新整理。', 'Could not connect to the room. Refresh shortly.']
    ,['暂时离席', '暫時離席', 'Sit out']
    ,['本手已结束', '本手已結束', 'Hand finished']
    ,['本手已结算。', '本手已結算。', 'Hand settled.']
    ,['本手已结算。可选择亮出自己的底牌。', '本手已結算。你可以選擇亮出自己的底牌。', 'Hand settled. You may show your cards.']
    ,['本手待结算', '本手待結算', 'Pending this hand']
    ,['本手结算后余额不足，卸码已取消。', '本手結算後餘額不足，卸碼已取消。', 'Cash-out canceled: too few chips after settlement.']
    ,['本手结算后筹码不足，排队卸码已取消。', '本手結算後籌碼不足，排隊卸碼已取消。', 'Queued cash-out canceled: too few chips after settlement.']
    ,['本手进行中入座，下手开始参与。', '本手進行中入座，下一手起參與。', 'You join from the next hand.']
    ,['来自 {name}', '來自 {name}', 'From {name}']
    ,['正在跑马发牌', '正在跑馬發牌', 'Dealing runout']
    ,['正在重连', '正在重新連線', 'Reconnecting']
    ,['现在展示花束，手末统一结算；不足会按 2,000 筹码自动补足。', '現在展示花束，本手結束後一併結算；若不足，會按每次 2,000 籌碼自動補足。', 'Bouquets show now and settle after this hand. Shortfalls trigger 2,000-chip rebuys.']
    ,['白玫瑰 ×{quantity}', '白玫瑰 ×{quantity}', 'White roses ×{quantity}']
    ,['立即结算；不足会按 2,000 筹码自动补足。', '立即結算；若不足，會按每次 2,000 籌碼自動補足。', 'Settles now. Shortfalls trigger 2,000-chip rebuys.']
    ,['等待结算', '等待結算', 'Settling']
    ,['筹码结算已更新。', '籌碼結算已更新。', 'Chip settlement updated.']
    ,['红玫瑰 ×{quantity}', '紅玫瑰 ×{quantity}', 'Red roses ×{quantity}']
    ,['行动超时：本手已自动弃牌并暂离。点“返回牌桌”可恢复。', '行動逾時：本手已自動棄牌並暫離。按「返回牌桌」可恢復。', 'Timed out: folded and sat out. Tap Return to come back.']
    ,['行动超时：本手已自动过牌，下手将暂离。点“返回牌桌”可取消。', '行動逾時：本手已自動過牌，下一手將暫離。按「返回牌桌」可取消。', 'Timed out: checked. You will sit out next hand; tap Return to cancel.']
    ,['补码', '補碼', 'Rebuy']
    ,['补码 2,000 已排队，本手结束结算。', '補碼 2,000 已排隊，本手結束後結算。', 'Rebuy of 2,000 queued until this hand ends.']
    ,['进入房间', '進入房間', 'Enter room']
    ,['进入房间观战', '進入房間觀戰', 'Enter and watch']
    ,['连接中', '連線中', 'Connecting']
    ,['连接中断', '連線中斷', 'Disconnected']
    ,['连接失败，请重试。', '連線失敗，請重試。', 'Connection failed. Try again.']
    ,['送礼', '送禮', 'Gifts out']
    ,['送给 {name}', '送給 {name}', 'To {name}']
    ,['卸码 2000 已到账', '卸碼 2000 已入帳', 'Cashed out 2,000.']
    ,['余额不足，卸码申请已取消', '餘額不足，卸碼申請已取消', 'Cash-out canceled: insufficient chips.']
    ,['礼物差额自动补码 {amount}', '禮物差額自動補碼 {amount}', 'Gift shortfall covered by an auto rebuy of {amount}.']
    ,['房间连续 24 小时未开局，已自动关闭。', '房間連續 24 小時未開局，已自動關閉。', 'This room closed automatically after 24 hours without a hand starting.']
    ,['房间关闭状态正在保存，请稍后重试', '房間關閉狀態正在儲存，請稍後重試', 'The room closure is being saved. Please try again shortly.']
    ,['房间存档暂时不可用，请联系管理员', '房間存檔暫時無法使用，請聯絡管理員', 'The room archive is temporarily unavailable. Please contact the administrator.']
    ,['自动过牌/弃牌', '自動過牌/棄牌', 'Auto Check/Fold']
    ,['过牌/弃牌', '過牌/棄牌', 'Check/Fold']
    ,['增加50筹码', '增加50籌碼', 'Add 50 chips']
    ,['减少50筹码', '減少50籌碼', 'Subtract 50 chips']
    ,['付费加时', '付費加時', 'Paid extra time']
    ,['加时', '加時', 'Time']
    ,['30秒后每10秒支付10筹码入池', '30秒後每10秒支付10籌碼入池', 'After 30 seconds, pay 10 chips into the pot per 10 seconds']
    ,['已开启加时：30秒后每10秒支付10筹码。', '已開啟加時：30秒後每10秒支付10籌碼。', 'Extra time enabled: after 30 seconds, 10 chips per 10 seconds.']
    ,['音效设置', '音效設定', 'Sound settings']
    ,['牌桌音效', '牌桌音效', 'Table sounds']
    ,['关闭音效设置', '關閉音效設定', 'Close sound settings']
    ,['开启音效', '開啟音效', 'Enable sounds']
    ,['音量', '音量', 'Volume']
    ,['试听', '試聽', 'Preview']
    ,['此浏览器不支持音效', '此瀏覽器不支援音效', 'Sounds are unavailable in this browser']
    ,['已静音', '已靜音', 'Muted']
    ,['音量为 0', '音量為 0', 'Volume is 0']
    ,['行动已更新，请重新选择。', '行動已更新，請重新選擇。', 'The turn has changed. Please choose again.']
    ,['声音已就绪', '聲音已就緒', 'Sound ready']
    ,['点击试听启用声音', '點擊試聽啟用聲音', 'Tap Preview to enable sound']
    ,['浏览器暂未允许播放，请再点一次试听。', '瀏覽器暫未允許播放，請再點一次試聽。', 'The browser has not enabled sound yet. Tap Preview again.']
  ];

  const dictionaries = { 'zh-TW': Object.create(null), en: Object.create(null) };
  for (const [key, traditional, english] of entries) {
    dictionaries['zh-TW'][key] = traditional;
    dictionaries.en[key] = english;
  }

  let language = 'zh-CN';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (LANGUAGES.has(stored)) language = stored;
  } catch { /* Storage can be unavailable in private browsing. */ }

  function t(key, params = {}) {
    if (typeof key !== 'string') return key;
    const template = dictionaries[language]?.[key] ?? key;
    return template.replace(/\{([a-zA-Z][\w]*)\}/g, (whole, name) => {
      const value = params?.[name];
      return value === undefined || value === null ? whole : String(value);
    });
  }

  function applyStatic(root = document) {
    const selector = '[data-i18n], [data-i18n-aria-label], [data-i18n-title], [data-i18n-placeholder], [data-i18n-content]';
    const nodes = [];
    if (root?.matches?.(selector)) nodes.push(root);
    if (root?.querySelectorAll) nodes.push(...root.querySelectorAll(selector));
    for (const node of nodes) {
      if (node.hasAttribute('data-i18n')) node.textContent = t(node.getAttribute('data-i18n'));
      for (const [dataAttribute, attribute] of [
        ['data-i18n-aria-label', 'aria-label'], ['data-i18n-title', 'title'],
        ['data-i18n-placeholder', 'placeholder'], ['data-i18n-content', 'content']
      ]) {
        if (node.hasAttribute(dataAttribute)) node.setAttribute(attribute, t(node.getAttribute(dataAttribute)));
      }
    }
  }

  function getLanguage() { return language; }

  function has(key, code = language) {
    return code === 'zh-CN' ? typeof key === 'string' : Boolean(dictionaries[code] && Object.hasOwn(dictionaries[code], key));
  }

  function setLanguage(code) {
    language = LANGUAGES.has(code) ? code : 'zh-CN';
    try { localStorage.setItem(STORAGE_KEY, language); } catch { /* Keep this tab translated. */ }
    document.documentElement.lang = language;
    const select = document.getElementById('language-select');
    if (select) select.value = language;
    applyStatic();
    document.dispatchEvent(new CustomEvent('poker-language-change', { detail: { language } }));
    return language;
  }

  const rank = '(?:10|[2-9TJQKA])';
  const pair = new RegExp(`^一对(${rank})$`);
  const twoPair = new RegExp(`^两[对队](${rank}),(${rank})$`);
  const trips = new RegExp(`^三条(${rank})$`);
  const quads = new RegExp(`^(?:炸弹|四条)(${rank})$`);
  const straight = new RegExp(`^(${rank})-(${rank})顺子$`);
  const highCard = new RegExp(`^(${rank})高牌$`);

  function hand(value) {
    if (typeof value !== 'string') return value;
    const source = value.trim().replace(/^两队/, '两对');
    if (language === 'zh-CN') return source;
    if (Object.hasOwn(dictionaries[language], source)) return t(source);
    let match;
    if ((match = source.match(twoPair))) return language === 'en'
      ? `Two pair ${match[1]},${match[2]}` : `兩對${match[1]},${match[2]}`;
    if ((match = source.match(pair))) return language === 'en' ? `Pair ${match[1]}` : `一對${match[1]}`;
    if ((match = source.match(trips))) return language === 'en' ? `Trips ${match[1]}` : `三條${match[1]}`;
    if ((match = source.match(quads))) return language === 'en' ? `Quads ${match[1]}` : `四條${match[1]}`;
    if ((match = source.match(straight))) return language === 'en'
      ? `Straight ${match[1]}–${match[2]}` : `${match[1]}-${match[2]}順子`;
    if ((match = source.match(highCard))) return language === 'en' ? `${match[1]} high` : `${match[1]}高牌`;
    return value;
  }

  function message(value) {
    if (typeof value !== 'string' || language === 'zh-CN') return value;
    if (Object.hasOwn(dictionaries[language], value)) return t(value);
    const patterns = [
      [/^加注总额须至少 (?<min>\d+)，或全下至 (?<max>\d+)$/, '加注总额须至少 {min}，或全下至 {max}'],
      [/^花束数量须为 (?<min>\d+) 至 (?<max>\d+) 的整数$/, '花束数量须为 {min} 至 {max} 的整数'],
      [/^(?<label>带入筹码|补码金额)须为 (?<min>\d+) 至 (?<max>\d+) 的整数$/, '{label}须为 {min} 至 {max} 的整数'],
      [/^房间容量调整为 (?<count>\d+) 人$/, '房间容量调整为 {count} 人'],
      [/^(?<name>.+) 将盲注调整为小盲 (?<small>\d+) \/ 大盲 (?<big>\d+)；下一手生效$/, '{name} 将盲注调整为小盲 {small} / 大盲 {big}；下一手生效'],
      [/^(?<name>.+) 赢得底池 (?<amount>\d+)（其他玩家弃牌）$/, '{name} 赢得底池 {amount}（其他玩家弃牌）'],
      [/^(?<name>.+) 两次牌面合计获得 (?<amount>\d+)$/, '{name} 两次牌面合计获得 {amount}'],
      [/^(?<name>.+) 跟注 (?<amount>\d+)(?<allIn>，全下)?$/, '{name} 跟注 {amount}{allIn}'],
      [/^(?<name>.+) 加时 (?<seconds>\d+) 秒，支付 (?<amount>\d+) 筹码入底池$/, '{name} 加时 {seconds} 秒，支付 {amount} 筹码入底池'],
      [/^(?<name>.+) 补码 (?<amount>\d+)$/, '{name} 补码 {amount}'],
      [/^(?<name>.+) 卸码 (?<amount>\d+)$/, '{name} 卸码 {amount}'],
      [/^礼物差额自动补码 (?<amount>\d+)$/, '礼物差额自动补码 {amount}'],
      [/^第 (?<handNo>\d+) 手开始；(?<name>.+) 持按钮，小盲 (?<small>\d+)，大盲 (?<big>\d+)$/, '第 {handNo} 手开始；{name} 持按钮，小盲 {small}，大盲 {big}']
    ];
    for (const [pattern, key] of patterns) {
      const match = value.match(pattern);
      if (match) {
        const params = { ...match.groups };
        if (params.label) params.label = t(params.label);
        params.allIn = params.allIn ? (language === 'en' ? ', all-in' : '，全下') : '';
        return t(key, params);
      }
    }
    return value;
  }

  // Error and system strings are kept separate from static copy for auditing.
  const messages = [
    ['当前手结束后才能调整大盲', '目前手牌結束後才能調整大盲', 'Wait until this hand ends to change the big blind.'],
    ['大盲须为 2 至 1000000 的整数', '大盲須為 2 至 1000000 的整數', 'Big blind must be an integer from 2 to 1,000,000.'],
    ['{name} 将盲注调整为小盲 {small} / 大盲 {big}；下一手生效', '{name} 將盲注調整為小盲 {small} / 大盲 {big}；下一手生效', '{name} set the blinds to {small} / {big}, effective next hand'],
    ['加时开关必须为开启或关闭', '加時開關必須為開啟或關閉', 'Extra time must be on or off.'],
    ['当前无法使用加时', '目前無法使用加時', 'Extra time is unavailable right now.'],
    ['可用筹码不足，不能跟注', '可用籌碼不足，不能跟注', 'Not enough chips to call.'],
    ['{name} 加时 {seconds} 秒，支付 {amount} 筹码入底池', '{name} 加時 {seconds} 秒，支付 {amount} 籌碼入底池', '{name} adds {seconds} seconds and pays {amount} chips into the pot'],
    ['请求过于频繁，请稍后再试', '請求過於頻繁，請稍後再試', 'Too many requests. Try again shortly.'],
    ['请求内容过大', '請求內容過大', 'Request is too large.'],
    ['请求须为 JSON 对象', '請求必須是 JSON 物件', 'Request must be a JSON object.'],
    ['JSON 格式错误', 'JSON 格式錯誤', 'Invalid JSON.'],
    ['请先输入昵称进入房间', '請先輸入暱稱進入房間', 'Enter a nickname to join the room first.'],
    ['请求编号已用于其他操作', '請求編號已用於其他操作', 'This request ID was used for another action.'],
    ['交易已记录，但房间状态暂时保存失败；请用同一请求编号重试', '交易已記錄，但房間狀態暫時儲存失敗；請用相同請求編號重試', 'Transaction recorded, but room save failed. Retry with the same request ID.'],
    ['房间状态保存暂时失败，请稍后再试', '房間狀態暫時無法儲存，請稍後再試', 'Room save failed. Try again shortly.'],
    ['礼物记录保存失败，未扣筹码', '禮物紀錄儲存失敗，未扣除籌碼', 'Gift record could not be saved; no chips were charged.'],
    ['卸码记录保存失败，未扣筹码', '卸碼紀錄儲存失敗，未扣除籌碼', 'Cash-out record could not be saved; no chips were removed.'],
    ['补码需要有效的请求编号', '補碼需要有效的請求編號', 'Rebuy needs a valid request ID.'],
    ['补码记录保存失败，本次补码未受理', '補碼紀錄儲存失敗，本次補碼未受理', 'Rebuy record could not be saved; request was not accepted.'],
    ['本手私有记录保存失败，下一手已暂停', '本手私人紀錄儲存失敗，下一手已暫停', 'Hand record could not be saved. The next hand is paused.'],
    ['找不到这个房间号', '找不到這個房間號碼', 'Room code not found.'],
    ['暂时无法创建房间，请重试', '暫時無法建立房間，請重試', 'Could not create a room. Try again.'],
    ['不支持此请求', '不支援此請求', 'Unsupported request.'],
    ['无效路径', '無效路徑', 'Invalid path.'],
    ['页面不存在', '頁面不存在', 'Page not found.'],
    ['不允许跨站请求', '不允許跨站請求', 'Cross-site request blocked.'],
    ['房间号须为 4–8 位数字', '房間號碼須為 4–8 位數字', 'Room code must have 4–8 digits.'],
    ['该房间号已存在', '該房間號碼已存在', 'That room code is already in use.'],
    ['记录分页参数无效', '紀錄分頁參數無效', 'Invalid history page.'],
    ['接口不存在', '介面不存在', 'Endpoint not found.'],
    ['不允许跨站连接', '不允許跨站連線', 'Cross-site connection blocked.'],
    ['WebSocket 路径不存在', 'WebSocket 路徑不存在', 'WebSocket path not found.'],
    ['凭证无效', '憑證無效', 'Invalid credentials.'],
    ['请输入昵称', '請輸入暱稱', 'Enter a nickname.'],
    ['昵称须为 1–18 个字符，不能包含控制字符或尖括号', '暱稱須為 1–18 個字元，且不能包含控制字元或尖括號', 'Nickname must be 1–18 characters, without control characters or angle brackets.'],
    ['此操作需要有效的请求编号', '此操作需要有效的請求編號', 'This action needs a valid request ID.'],
    ['房间人数须为 4–10', '房間人數須為 4–10', 'Table size must be 4–10.'],
    ['登录凭证已失效，请重新输入昵称', '登入憑證已失效，請重新輸入暱稱', 'Session expired. Enter your nickname again.'],
    ['登录凭证已失效，请重新进入房间', '登入憑證已失效，請重新進入房間', 'Session expired. Rejoin the room.'],
    ['礼物展示中，请稍后再试', '禮物展示中，請稍後再試', 'Gift animation is playing. Try again shortly.'],
    ['你已经入座', '你已經入座', 'You are already seated.'],
    ['无效座位', '無效座位', 'Invalid seat.'],
    ['该座位已有人', '該座位已有人', 'That seat is taken.'],
    ['你尚未入座', '你尚未入座', 'You are not seated.'],
    ['已参与当前手，结算后才能离座', '已參與目前手牌，結算後才能離座', 'Finish this hand before leaving your seat.'],
    ['本手还有待结算的礼物或筹码操作，结算后才能离座', '本手還有待結算的禮物或籌碼操作，結算後才能離座', 'Settle this hand’s gifts and chips before leaving.'],
    ['你已经暂时离席', '你已經暫時離席', 'You are already sitting out.'],
    ['已安排从下一手暂离', '已安排從下一手暫離', 'You will sit out from the next hand.'],
    ['你已在牌桌上', '你已在牌桌上', 'You are already back at the table.'],
    ['礼物展示中，牌局暂时暂停', '禮物展示中，牌局暫時暫停', 'Game paused for the gift animation.'],
    ['先选择座位才能补码', '請先選擇座位再補碼', 'Choose a seat before rebuying.'],
    ['每次补码须为 2000', '每次補碼須為 2000', 'Each rebuy must be 2,000 chips.'],
    ['补码后筹码超过上限', '補碼後籌碼超過上限', 'Rebuy would exceed the chip limit.'],
    ['补码累计金额过大', '補碼累計金額過大', 'Total rebuys are too large.'],
    ['入座后才能赠送花束', '入座後才能贈送花束', 'Sit down before sending a bouquet.'],
    ['收礼玩家尚未入座', '收禮玩家尚未入座', 'The recipient is not seated.'],
    ['不能送礼给自己', '不能送禮給自己', 'You cannot send a gift to yourself.'],
    ['请选择白玫瑰或红玫瑰', '請選擇白玫瑰或紅玫瑰', 'Choose white or red roses.'],
    ['待结算礼物总额过大', '待結算禮物總額過大', 'Pending gift total is too large.'],
    ['礼物累计金额过大', '禮物累計金額過大', 'Gift total is too large.'],
    ['巨型花束正在冷却中，请稍后再试', '巨型花束正在冷卻中，請稍後再試', 'Grand bouquet is on cooldown. Try again shortly.'],
    ['悄悄话正在冷却中，请稍后再试', '悄悄話正在冷卻中，請稍後再試', 'Secret phrase is on cooldown. Try again shortly.'],
    ['当前可卸筹码不足 2000', '目前可卸籌碼不足 2000', 'You need 2,000 available chips to cash out.'],
    ['只有房主可以调整人数', '只有房主可以調整人數', 'Only the host can change table size.'],
    ['当前手结束后才能调整人数', '目前手牌結束後才能調整人數', 'Change table size after this hand.'],
    ['缩小人数前请先清空末尾座位', '縮小人數前請先清空末端座位', 'Empty the last seats before reducing table size.'],
    ['当前未轮到你选择跑马次数', '目前未輪到你選擇跑馬次數', 'It is not your turn to choose the runout.'],
    ['请选择发一次或两次', '請選擇發一次或兩次', 'Choose one or two runouts.'],
    ['当前未轮到你确认跑马次数', '目前未輪到你確認跑馬次數', 'It is not your turn to confirm the runout.'],
    ['请选择接受或拒绝', '請選擇接受或拒絕', 'Choose accept or decline.'],
    ['只有在牌桌上的玩家可以开始牌局', '只有入座玩家可以開始牌局', 'Only a seated player can start a hand.'],
    ['这一手尚未结束', '這手牌尚未結束', 'This hand is still in progress.'],
    ['至少两名入座玩家有筹码才能开始', '至少兩名入座玩家有籌碼才能開始', 'At least two seated players need chips to start.'],
    ['请等待本手展示结束，下一手将在倒计时后自动开始', '請等候本手牌展示結束；下一手將於倒數後自動開始', 'Wait for the result display. The next hand starts automatically.'],
    ['当前未轮到你行动', '目前未輪到你行動', 'It is not your turn.'],
    ['面对下注不能过牌', '面對下注不能過牌', 'You cannot check facing a bet.'],
    ['目前无需跟注', '目前無需跟注', 'There is nothing to call.'],
    ['当前不能加注', '目前不能加注', 'You cannot raise now.'],
    ['未知行动', '未知行動', 'Unknown action.'],
    ['只能在当前手结算后亮出自己的底牌', '只能在目前手牌結算後亮出自己的底牌', 'You can show your cards only after this hand ends.'],
    ['只能亮出自己当前手已结算且尚未公开的底牌', '只能亮出自己目前手牌已結算且未公開的底牌', 'Only your unshown cards from the finished hand can be revealed.'],
    ['找不到该手的结算记录', '找不到該手牌的結算紀錄', 'Hand result not found.'],
    ['命令格式错误', '命令格式錯誤', 'Invalid command format.'],
    ['命令失败', '命令失敗', 'Action failed.'],
    ['未知命令', '未知命令', 'Unknown command.'],
    ['{label}须为 {min} 至 {max} 的整数', '{label}須為 {min} 至 {max} 的整數', '{label} must be an integer from {min} to {max}.'],
    ['花束数量须为 {min} 至 {max} 的整数', '花束數量須為 {min} 至 {max} 的整數', 'Bouquet count must be an integer from {min} to {max}.'],
    ['加注总额须至少 {min}，或全下至 {max}', '加注總額須至少 {min}，或全下至 {max}', 'Raise to at least {min}, or go all-in to {max}.'],
    ['房间容量调整为 {count} 人', '房間容量調整為 {count} 人', 'Table size changed to {count}.'],
    ['{name} 赢得底池 {amount}（其他玩家弃牌）', '{name} 贏得底池 {amount}（其他玩家棄牌）', '{name} wins pot {amount} (others folded).'],
    ['{name} 两次牌面合计获得 {amount}', '{name} 兩次牌面合計獲得 {amount}', '{name} wins {amount} across both boards.'],
    ['{name} 跟注 {amount}{allIn}', '{name} 跟注 {amount}{allIn}', '{name} calls {amount}{allIn}'],
    ['{name} 补码 {amount}', '{name} 補碼 {amount}', '{name} rebuys {amount}.'],
    ['{name} 卸码 {amount}', '{name} 卸碼 {amount}', '{name} cashes out {amount}.'],
    ['第 {handNo} 手开始；{name} 持按钮，小盲 {small}，大盲 {big}', '第 {handNo} 手開始；{name} 持按鈕，小盲 {small}，大盲 {big}', 'Hand {handNo} starts; {name} has the button. Blinds {small}/{big}.']
  ];
  for (const [key, traditional, english] of messages) {
    dictionaries['zh-TW'][key] = traditional;
    dictionaries.en[key] = english;
  }

  window.PokerI18n = Object.freeze({ t, getLanguage, setLanguage, has, hand, message, applyStatic });
  document.documentElement.lang = language;
  const initialize = () => {
    applyStatic();
    const select = document.getElementById('language-select');
    if (select) {
      select.value = language;
      select.addEventListener('change', () => setLanguage(select.value));
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
