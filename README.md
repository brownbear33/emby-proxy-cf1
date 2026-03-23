# Emby 反代优选线路管理中心

这是一个用于管理 Emby 反代线路的小站点，适合自己部署自用。

它基于 Cloudflare Workers + D1，当前支持两类能力：

- 线路管理：记录访问域名、回源域名、优选域名、权重、标签、备注
- DNS 自动同步：把 `访问域名 -> 优选域名` 自动同步到 Cloudflare DNS

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zzzwannasleep/EmbyProxySite)

## 现在已经能自动联动什么

当前版本已经支持 Cloudflare DNS 自动同步。

当你配置好 Cloudflare 参数后：

- 新增启用线路：自动创建 CNAME
- 修改启用线路：自动更新 CNAME
- 停用线路：自动删除受管 CNAME
- 删除线路：先删除受管 CNAME，再删除线路

当前版本还不会自动联动：

- Worker Route
- Custom Domain
- 回源规则
- 源站证书
- 其他 Cloudflare 面板策略

也就是说，现在自动化的范围是：

- `访问域名 -> 优选域名` 的 DNS 同步

不是：

- `回源域名 -> Emby 源站` 的完整反代编排

## 主要功能

- 线路增删改查
- 按权重排序
- 启用 / 停用线路
- 批量整合复制
- 卡片式展示
- Cloudflare DNS 自动同步状态展示

## 部署前需要准备

- 一个 Cloudflare 账号
- 一个已经接入 Cloudflare 的域名
- 已安装并登录 `wrangler`
- 一个 D1 数据库
- 一个后台密码 `ADMIN_PASSWORD`

如果你要启用自动同步，还需要：

- 一个有 DNS 编辑权限的 Cloudflare API Token
- 可选的 `CF_ZONE_ID`
  如果不填，系统会根据 `访问域名` 自动识别最匹配的 Zone

如果你还没登录 `wrangler`：

```bash
wrangler login
```

## 你需要准备哪些域名

建议至少区分下面几类域名：

- 面板域名：比如 `panel.example.com`
  这个域名只用于打开本管理中心。
- 访问域名：比如 `emby.example.com`
  这是用户最终访问的域名。
- 回源域名：比如 `origin.example.com` 或你的服务器公网 IP
  这是你的 Emby 实际源站。
- 优选域名：比如 `youxuan.cf.090227.xyz`
  这是你要同步到 Cloudflare DNS 的目标域名。

## 字段应该怎么填

新增线路时：

- `访问域名`：用户最终访问的域名，例如 `emby.example.com`
- `回源域名`：你的 Emby 源站域名或 IP，例如 `origin.example.com`
- `优选域名`：你已有的优选域名，例如 `youxuan.cf.090227.xyz`

当前版本中：

- `访问域名` 会参与 Cloudflare DNS 自动同步
- `优选域名` 会作为 CNAME 目标
- `回源域名` 目前仅用于线路记录与展示，不会自动写入 Cloudflare

## Cloudflare 自动同步的工作方式

配置完成后，项目会把每条线路同步成一条 Cloudflare DNS CNAME：

```text
访问域名  ->  优选域名
```

例如：

```text
emby.example.com  ->  youxuan.cf.090227.xyz
```

### 安全策略

为了避免把你手动维护的记录覆盖掉，项目会尽量保守：

- 如果目标域名下已经有非 CNAME 记录，不会自动覆盖
- 如果已经有别的 CNAME 指向其他目标，不会自动覆盖
- 如果发现已存在完全相同的 CNAME，会接管并继续同步

如果命中这些保护规则，线路会保存成功，但卡片上会显示 `CF同步失败`，并附带原因。

## 推荐的最小接入流程

1. 把你的主域名接入 Cloudflare
2. 创建 D1 数据库
3. 执行数据库迁移
4. 设置 `ADMIN_PASSWORD`
5. 如果要自动同步，先设置 `CF_API_TOKEN`
6. 如果你只想固定到单个 Zone，可再设置 `CF_ZONE_ID`
7. 部署本项目到 Workers
8. 给管理中心绑定 `workers.dev` 或自定义域名
9. 登录面板录入线路，使用内置 Cloudflare 状态面板检测和补偿同步

## 手动部署步骤

### 1. 创建 D1 数据库

```bash
wrangler d1 create emby_proxy
```

执行后会返回一个 `database_id`，把它填进 `wrangler.toml` 里的 `database_id`。

### 2. 执行数据库迁移

```bash
wrangler d1 migrations apply emby_proxy
```

如果你是从旧版本升级，这一步也必须执行，因为现在新增了 Cloudflare 同步状态字段。

### 3. 设置后台密码

```bash
wrangler secret put ADMIN_PASSWORD
```

### 4. 设置 Cloudflare 自动同步参数

至少配置：

```bash
wrangler secret put CF_API_TOKEN
```

可选配置：

```bash
wrangler secret put CF_ZONE_ID
```

说明：

- 配了 `CF_ZONE_ID`：系统固定使用这个 Zone
- 不配 `CF_ZONE_ID`：系统会根据 `访问域名` 自动匹配 Cloudflare Zone

`CF_API_TOKEN` 需要至少具备：

- Zone DNS Edit
- Zone Zone Read

可选参数：

- `CF_DNS_PROXIED`
  默认是 `true`
  如果你希望关闭橙云代理，可以在 `wrangler.toml` 里加：

```toml
[vars]
CF_DNS_PROXIED = "false"
```

### 5. 构建并部署

```bash
npm install
npm run build
wrangler deploy
```

### 6. 给管理中心绑定访问地址

部署完 Worker 后，你可以二选一：

- 直接使用 Cloudflare 自动分配的 `*.workers.dev`
- 给 Worker 绑定自定义域名，例如 `panel.example.com`

## 使用示例

假设你的环境是：

- 面板域名：`panel.example.com`
- 访问域名：`emby.example.com`
- 回源域名：`origin.example.com`
- 优选域名：`youxuan.cf.090227.xyz`

那么：

1. 通过 `https://panel.example.com` 打开管理中心
2. 新增一条线路
3. `访问域名` 填 `emby.example.com`
4. `回源域名` 填 `origin.example.com`
5. `优选域名` 填 `youxuan.cf.090227.xyz`
6. 如果线路启用且 Cloudflare 参数已配置，系统会自动在 Cloudflare DNS 中创建：

```text
emby.example.com  ->  youxuan.cf.090227.xyz
```

## 同步状态说明

页面卡片里会显示 Cloudflare 同步状态：

- `CF已同步`：DNS 已成功创建或更新
- `CF已停用`：线路已停用，受管 DNS 已删除或无需删除
- `CF未配置`：没有配置 `CF_API_TOKEN` 或 `CF_ZONE_ID`
- `CF同步失败`：保存成功，但 Cloudflare 同步没有成功
- `CF待同步`：旧数据还没重新保存过，或者刚升级完迁移

此外，页面上方还有一块 `Cloudflare 自动联动` 面板，可以直接：

- 刷新当前 Cloudflare 状态
- 检测某个访问域名会命中哪个 Zone
- 重试异常线路
- 全量重同步
- 重同步已选中的线路

## 常见问题

### 忘记密码怎么办

重新执行一次：

```bash
wrangler secret put ADMIN_PASSWORD
```

### 为什么线路保存成功了，但 CF 没同步

常见原因有：

- 没配置 `CF_API_TOKEN`
- 目标域名下已经有非 CNAME 记录
- 已存在你手动维护的其他 CNAME，项目为了安全没有覆盖

可以直接看页面卡片上的 Cloudflare 同步状态和提示信息。

如果你没配置 `CF_ZONE_ID`，还可以直接在页面上方的 Cloudflare 面板里查看自动匹配结果。

### 删除线路时报错，说不能安全删除 Cloudflare 记录

说明这条线路之前已经由本项目托管过 DNS 记录，但当前环境没有可用的 Cloudflare 凭据。

这时需要先恢复：

- `CF_API_TOKEN`
- `CF_ZONE_ID`

然后再删除，或者先手动去 Cloudflare 后台删除对应记录。

### 这个项目后面还能继续扩展什么

下一步可以继续加：

- Worker Route / 自定义域名辅助配置
- 线路级别的同步历史记录
- Cloudflare 配置向导
