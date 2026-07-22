# Cutout Studio

本機優先的創作者去背與尺寸整理工具。適合把手繪圖、個人照片、透明素材整理成 LINE 主題、社群頭像、貼圖草稿或其他小尺寸素材。

原圖不會被覆寫，匯出時另存透明 PNG。目標是先自動完成去背、遮罩清理、主體置中與尺寸輸出；橡皮擦保留給少數自動處理不了的邊角修補。

## 功能

- 批次匯入 JPG、PNG、WebP
- 本機 AI 自動去背
- 自動遮罩清理：去雜點、alpha threshold、內縮與柔邊
- 多主體區塊策略：全部、最大、前 2、靠中心
- 手動橡皮擦與復原
- LINE 常用尺寸與自訂尺寸
- 資料夾批次輸出與 ZIP 打包
- 透明 PNG 下載

## 素材與授權提醒

這個 repo 只提供工具，不內建任何照片、角色圖、模型輸出範例或第三方素材。使用者應自行確認輸入素材是否具有合法使用權，尤其是商業角色、動畫截圖、名人照片、LINE 主題上架素材與任何需要肖像權或著作權授權的圖片。

工具採 MIT License；但你用工具處理的圖片不會因此自動取得 MIT 授權。

## 啟動

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python ../server.py --port 3000
```

開啟 `http://127.0.0.1:3000/creator_tool/`。主題編輯器與 Cutout Studio
共用同一個圖像處理服務。

## 自動去背

自動去背使用本機 `rembg` 與輕量 `u2netp` 模型：

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python ../server.py --port 3000
```

開啟 `http://127.0.0.1:3000/creator_tool/`。首次去背時 `rembg` 會下載模型。
未安裝時，仍可使用匯入、橡皮擦、主體置中、尺寸預設與 PNG 匯出。

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

## 適合與不適合

適合：

- 透明手繪圖、角色草圖、個人照片
- 背景與人物差異明顯的照片
- 需要快速整理成小尺寸 PNG 的創作者流程

目前較不適合：

- 低對比黑白截圖
- 主體和背景顏色非常接近的圖片
- 需要精準逐人辨識的多人照片
- 高度依賴商業 IP 授權的素材流程

## Roadmap

- 批次去背佇列
- 命名規則與 ZIP 匯出模板
- 專案儲存與載入
- 手動框選主體範圍
- 臉部模式
- LINE 主題規格驗證

## License

MIT
