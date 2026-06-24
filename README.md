# Cutout Studio

本機優先的創作者去背與尺寸整理工具。原圖不會被覆寫，匯出時另存透明 PNG。

## 啟動

```bash
python3 server.py --port 4173
```

開啟 `http://127.0.0.1:4173`。

## 自動去背

自動去背使用本機 `rembg` 與輕量 `u2netp` 模型：

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python server.py --port 4173
```

首次去背時 `rembg` 會下載模型。未安裝時，仍可使用匯入、橡皮擦、主體置中、尺寸預設與 PNG 匯出。

## MVP 範圍

- 批次匯入 JPG、PNG、WebP
- 本機 AI 自動去背
- 手動橡皮擦與復原
- 依 Alpha 邊界自動置中
- LINE 常用尺寸與自訂尺寸
- 安全留白與透明 PNG 下載

後續再加入批次去背佇列、命名規則、專案儲存與 LINE 主題規格驗證。
