# IM 行動教會 · 春酒抽獎系統

## 🚀 部署到 Railway（5分鐘完成）

### 步驟一：上傳到 GitHub
1. 在 [github.com](https://github.com) 新建一個 Repository（例如 `im-lottery`）
2. 把這個資料夾裡的所有檔案上傳進去

### 步驟二：部署到 Railway
1. 前往 [railway.app](https://railway.app) 並用 GitHub 登入
2. 點 **「New Project」** → **「Deploy from GitHub repo」**
3. 選擇剛剛建立的 Repository
4. Railway 會自動偵測 Node.js 專案並部署
5. 部署完成後，點 **「Generate Domain」** 取得公開網址

### 步驟三：完成！
- 把網址分享給現場所有人用手機掃描/開啟登記
- 管理員密碼預設為 `1234`（可在 `public/index.html` 裡修改 `const PIN = '1234'`）

---

## 📁 檔案結構
```
lottery-app/
├── server.js        # 後端 Node.js + Express
├── package.json     # 依賴套件設定
├── .gitignore
└── public/
    └── index.html   # 前端（報名頁 + 管理後台）
```

## 💾 資料儲存
- 所有資料儲存在 `data.json`（伺服器端）
- Railway 部署後資料會持久保存
- 重新部署不會清除資料

## 🔐 管理員密碼
修改 `public/index.html` 第一行 JS：
```javascript
const PIN = '1234';  // ← 改這裡
```
