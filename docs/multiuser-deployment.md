# 多用户与在线房间部署

此版本支持自行注册、管理员创建账号、邀请链接游客入座，以及真人与 AI 同房轮流作画、猜词。每个账号保存独立 AI 配置，房间使用房主的配置。只需浏览器，换设备登录即可继续使用。在线房间最多 8 位真人、总选手最多 13 位；原有的人机比赛、传画接龙和 Live2D 页面保留。在线房间当前使用轮流画猜规则。加密与迁移见 [AI 配置安全说明](ai-config-security.md)。

## 更新已有服务器

1. 停止旧进程，备份原项目及整个 `.local/` 和 `.env`。
2. 将本版本源码覆盖到项目目录，保留原来的 `.local/`、`.env`、已安装的角色模型和 Live2D Core。
3. 使用 Node.js 24 LTS（最低 22.13），在项目目录执行 `npm ci --omit=dev`。
4. 在 `.env` 中补充以下配置，再用原来的进程管理器启动 `npm start`：

```dotenv
PORT=3211
BIND_HOST=127.0.0.1
PUBLIC_ORIGIN=https://draw.example.com
ALLOW_REGISTRATION=true
ALLOW_GUESTS=true
MAX_DAILY_MATCHES=20
MAX_DAILY_AI_CALLS=300
MAX_DAILY_TOTAL_AI_CALLS=1000
```

将域名替换成实际站点地址。`PUBLIC_ORIGIN` 必须是完整站点根地址，不能包含 `/game/` 等路径。域名和反向代理转发的 Host 必须一致；HTTPS 站点会自动使用 Secure 会话 Cookie。程序保持监听回环地址，由 HTTPS 反向代理对外提供访问。

启动日志会显示一次初始化码。打开 `/online`，填写初始化码、账号、昵称和至少 10 位的密码，创建首位管理员。已有管理员后，初始化入口自动关闭。没有固定默认密码。

每个注册用户可在“我的 AI”或游戏“AI 设置”中保存自己的模型、接口和 Key。Key 按账号加密，普通用户不会继承管理员 Key。管理员可发布不含密钥的新用户模型模板，以及全站默认题库、难度、题数和提示规则；既有个人配置不被模板覆盖。纯真人房间不需要 Key。

## 宝塔 / Nginx 反向代理

先在站点启用 HTTPS，将下面两个 location 放进该站点的 `server` 配置中。如已有 `location /`，替换它而不是重复添加。

```nginx
location / {
    proxy_pass http://127.0.0.1:3211;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 300s;
    client_max_body_size 4m;
}

location /ws/ {
    proxy_pass http://127.0.0.1:3211;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

## 账号与邀请

- 自行注册：在登录页切换“注册账号”。管理员仍可创建、停用账号和重置玩家密码。
- 游客加入：房主复制邀请链接，朋友打开后填写昵称即可入座，不需要先注册。游客只能通过房间码或邀请加入；注册后才能创建房间或玩独立人机对局。
- 游客转账号：展开“注册账号，保存我的对局记录”，设置账号和密码。用户 ID 保持不变，当前房间、得分和已有对局访问权都会保留。
- 游客身份在 24 小时后过期。未注册游客失去访问权；同场正式账号仍可查看共享对局记录。
- 正式账号、登录会话、管理员配置及对局记录保存在 `.local/`。在“我的对局”中查看自己的素材；管理员可查看所有已结束对局。
- 关闭公开注册或游客入口时，将相应环境变量设成 `false` 并重启。

房间和正在进行的对局保存在内存中，服务重启后需重新创建房间；账号、已保存记录和配置会保留。刷新网页或短暂断线可以重连同一房间。主动离开会结束当前比赛，剩余成员可重新开局；房主离开后会移交房主。连续 6 小时无活动的房间会清理。管理员维护期间应先结束比赛再重启服务。

## 配额与备份

默认每个账号每天最多开局 20 次、调用 AI 300 次，全站游戏 AI 调用最多 1000 次。房间的额度计入房主；失败重试也计次数。全站上限覆盖所有正式账号及游客，避免通过新账号绕过总额度。额度在 UTC 00:00（香港时间 08:00）重置。次数上限不等于金额上限；模型供应商账户仍应配置相应预算。

密码使用带随机盐的 scrypt 哈希，会话令牌仅以哈希保存。完整个人 AI 配置用 AES-256-GCM 加密存入 SQLite，页面不回显 Key。调用时服务器会解密，运维有能力获得明文。普通账号自定义接口限公网 HTTPS；管理员可使用本地模型或服务器 Codex。停用账号或重置密码撤销会话并移出房间，个人配置保留。

备份时停止服务，复制整个 `.local/`、`.env` 及外部管理的主密钥。默认主密钥是 `.local/config-master.key`；也可在首次部署前通过 `CONFIG_ENCRYPTION_KEY` 设置随机 32 字节密钥的 Base64 或 64 位十六进制。务必保留相同主密钥，丢失后无法恢复 Key。SQLite 使用 WAL，不要只复制正在写入的 `accounts.sqlite`。首位管理员初次读取配置时会导入旧 JSON 和环境变量中的 Key，并脱敏旧 JSON；旧 `.env` 仍需保管。

## Docker（可选）

```bash
docker build -t ai-draw-guess-online .
docker run -d --name draw-guess --restart unless-stopped \
  -p 127.0.0.1:3211:3211 \
  -e PUBLIC_ORIGIN=https://draw.example.com \
  -v draw-guess-data:/app/.local \
  ai-draw-guess-online
docker logs draw-guess
```

继续使用上述 Nginx 配置。Docker 部署同样需要单独安装角色模型及官方 Core；可先在构建目录安装，再重新构建镜像。应用源码不包含这些资源。

当前实现面向单个 Node.js 服务进程；请使用 PM2 单实例模式，不能直接开多个 worker 共享内存房间。没有在你的服务器实际部署，也未使用真实付费 API 验证供应商连通性；上线前由管理员在 AI 设置中验证自己使用的型号。
