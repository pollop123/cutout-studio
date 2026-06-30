# Cutout Studio

本機優先的創作者去背與尺寸整理工具。原圖不會被覆寫，匯出時另存透明 PNG。

目標是讓手繪圖、截圖與個人照片能先自動完成去背、遮罩清理、主體置中與尺寸輸出；橡皮擦保留給少數自動處理不了的邊角修補。

## 啟動

```bash
python3 server.py serve --port 4173
```

開啟 `http://127.0.0.1:4173`。

## 自動去背

自動去背使用本機 `rembg` 與輕量 `u2netp` 模型：

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python server.py serve --port 4173
```

首次去背時 `rembg` 會下載模型。未安裝時，仍可使用匯入、橡皮擦、主體置中、尺寸預設與 PNG 匯出。

## 主體策略

工具會先依透明度找出前景區塊，再用策略決定輸出範圍：

- `全部保留`：把所有前景當成一個整體，適合團體照。
- `只保留最大主體`：適合有路人、雜物或兩個人物但只要主角時。
- `保留前 2 個主體`：適合雙人照。
- `保留最靠中心主體`：適合主角在畫面中央但旁邊有干擾物時。

這是 alpha 區塊分析，不是臉部辨識；若兩個人身體相連，會被視為同一個主體。

## 遮罩清理

自動去背後會套用遮罩清理，也可以調整參數後手動重跑，減少殘邊、光暈與小雜點：

- `照片自然`：保守清理，適合真人照片。
- `手繪乾淨`：移除掃描或截圖的小雜點，盡量保留線條。
- `卡通截圖`：較積極移除半透明光暈與背景殘留。
- `不清理`：保留原始去背結果。

清理強度會同時影響 alpha threshold、遮罩內縮、柔邊與小元件移除。強度太高可能吃掉細髮、手指、細線；這時降低強度後再用橡皮擦修局部。

## 批次自動化

可以直接處理整個資料夾，輸出 LINE 常用尺寸：

```bash
venv/bin/python server.py batch ./photos --output ./outputs --subject-mode top2 --cleanup-preset photo --zip cutouts.zip
```

常用參數：

```bash
--subject-mode all|largest|top2|center
--cleanup-preset off|photo|drawing|cartoon
--cleanup-strength 50
--padding 12
--preset line-icons
--size 240x240
--skip-remove
```

`--skip-remove` 適合已經是透明 PNG 的素材；一般照片不要加，工具會先自動去背。

## MVP 範圍

- 批次匯入 JPG、PNG、WebP
- 本機 AI 自動去背
- 手動橡皮擦與復原
- 依 Alpha 邊界自動置中
- 多主體區塊策略
- 自動遮罩清理：去雜點、alpha threshold、內縮與柔邊
- 資料夾批次輸出與 ZIP 打包
- LINE 常用尺寸與自訂尺寸
- 安全留白與透明 PNG 下載

後續再加入批次去背佇列、命名規則、專案儲存、臉部模式與 LINE 主題規格驗證。
