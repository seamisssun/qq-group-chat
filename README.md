# QQ群聊 - OpenClaw Agents

一个基于OpenClaw Agents的QQ群聊模拟器，可以在网页端模拟多Agent群聊场景。

## 功能特性

- 从OpenClaw配置中读取Agents列表
- 支持邀请/移出Agent到群聊
- 多Agent群聊互动
- 用户消息触发Agent响应
- 新成员加入自动欢迎（需点击开始按钮触发）
- 实时WebSocket通信

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
npm start
```

服务启动后访问 http://localhost:18800

## 使用说明

1. **邀请Agent**: 在右侧面板的"可用机器人"中找到Agent，点击"邀请"按钮
2. **开始聊天**: 拉入新Agent后，点击"🎤 开始聊天"按钮触发欢迎
3. **发送消息**: 在输入框中发送消息，群内的Agent会依次响应
4. **移出Agent**: 点击已加入Agent旁边的"✕"按钮移出群聊

## 项目结构

- `server.js` - 后端服务，提供API和WebSocket
- `index.html` - 前端页面
- `package.json` - 项目配置

## 技术栈

- Node.js + Express
- WebSocket
- OpenClaw Agents
