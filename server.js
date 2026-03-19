import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const execAsync = promisify(exec);

// 性能监控
const performanceMonitor = {
  metrics: new Map(),
  
  start(operationId) {
    this.metrics.set(operationId, { startTime: Date.now(), startMemory: process.memoryUsage().heapUsed });
  },
  
  end(operationId) {
    const metric = this.metrics.get(operationId);
    if (metric) {
      const duration = Date.now() - metric.startTime;
      const endMemory = process.memoryUsage().heapUsed;
      const memoryDelta = (endMemory - metric.startMemory) / 1024 / 1024;
      metric.duration = duration;
      metric.memoryDelta = memoryDelta;
      metric.endTime = Date.now();
      console.log(`[性能监控] ${operationId}: ${duration}ms, 内存变化: ${memoryDelta.toFixed(2)}MB`);
      return metric;
    }
    return null;
  },
  
  getMetrics(operationId) {
    return this.metrics.get(operationId);
  },
  
  clear() {
    this.metrics.clear();
  }
};

// 并发执行Agent欢迎任务
async function executeWelcomeTask(agent, performanceId, maxRetries = 3) {
  if (!agent || !agent.id) {
    return {
      agent: agent || { id: 'unknown', name: 'Unknown' },
      success: false,
      response: null,
      filteredResponse: '',
      error: 'Agent ID is missing or invalid'
    };
  }
  
  performanceMonitor.start(performanceId);
  
  const command = `openclaw agent --agent ${agent.id} --message "/new" --deliver`;
  console.log('[欢迎新成员]', command);
  
  let lastError = null;
  
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      
      const response = stdout ? stdout.trim() : '';
      console.log('[欢迎响应]', agent.name, response);
      
      // 如果返回completed，继续重试
      if (response && response.toLowerCase().includes('completed')) {
        console.log('[欢迎响应包含completed，重试]', agent.name, `(${retry + 1}/${maxRetries})`);
        lastError = 'completed';
        continue;
      }
      
      // 成功响应
      const result = {
        agent,
        success: true,
        response: response,
        filteredResponse: response ? filterResponse(response) : '',
        error: null
      };
      
      performanceMonitor.end(performanceId);
      return result;
      
    } catch (error) {
      console.error('[欢迎Agent失败]', agent.name, error.message);
      lastError = error.message;
      // 继续重试
    }
  }
  
  // 达到最大重试次数，返回失败
  console.error('[欢迎Agent重试耗尽]', agent.name, '错误:', lastError);
  performanceMonitor.end(performanceId);
  
  return {
    agent,
    success: false,
    response: null,
    filteredResponse: '',
    error: lastError || '重试耗尽'
  };
}

const app = express();
const PORT = 18800;
const server = createServer(app);
const wss = new WebSocketServer({ server });

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// WebSocket客户端管理
let wsClients = [];

wss.on('connection', (ws) => {
  console.log('[WebSocket] 新客户端连接');
  wsClients.push(ws);
  
  ws.on('close', () => {
    console.log('[WebSocket] 客户端断开');
    wsClients = wsClients.filter(client => client !== ws);
  });
});

function sendWSMessage(data) {
  console.log('[WebSocket推送] 客户端数量:', wsClients.length, '类型:', data.type);
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function filterResponse(text) {
  if (!text) return '';
  return text
    .replace(/[a-zA-Z]/g, '')
    .replace(/[\/\\[\]()]/g, '')
    .replace(/"/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 读取本地OpenClaw配置
function loadOpenClawConfig() {
  const configPath = 'C:\\Users\\Administrator\\.openclaw\\openclaw.json';
  try {
    if (existsSync(configPath)) {
      let content = readFileSync(configPath, 'utf-8');
      // 移除JSON注释（只移除行首的//注释，保留URL中的//）
      content = content
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*\]/g, ']');
      // 移除无效的控制字符
      content = content.replace(/[\x00-\x1F\x7F]/g, '');
      return JSON.parse(content);
    }
  } catch (e) {
    console.error('读取配置失败:', e);
  }
  return null;
}

// 获取Gateway Token
function getGatewayToken() {
  const config = loadOpenClawConfig();
  return config?.gateway?.auth?.token || '';
}

// 读取agent的IDENTITY.md
function loadAgentIdentity(agentId) {
  const config = loadOpenClawConfig();
  if (!config?.agents?.list) return { name: agentId, emoji: '🤖' };

  const agent = config.agents.list.find(a => a.id === agentId);
  if (!agent) return { name: agentId, emoji: '🤖' };

  if (!agent.workspace) {
    return { name: agent.name || agentId, emoji: '🤖' };
  }

  const identityPath = join(agent.workspace, 'IDENTITY.md');
  try {
    if (existsSync(identityPath)) {
      const content = readFileSync(identityPath, 'utf-8');
      const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)|\*\*姓名：\*\*\s*(.+)/);
      const emojiMatch = content.match(/\*\*Emoji:\*\*\s*(.+)/);
      const name = nameMatch ? (nameMatch[1] || nameMatch[2]).trim() : null;

      return {
        name: name || agent.name || agentId,
        emoji: emojiMatch ? emojiMatch[1].trim() : '🤖'
      };
    }
  } catch (e) {
    console.error(`读取 ${agentId} 的IDENTITY失败:`, e);
  }

  return { name: agent.name || agentId, emoji: '🤖' };
}

// 群聊状态
let groupState = {
  agents: [],             // 群里的agents
  lastSender: null,       // 上一个发送消息的agent
  lastMessageSender: null, // 上一个发出信息的单位 { name: string, type: 'user' | 'agent' }
  messageHistory: [],     // 消息历史
  canUserSpeak: false,    // 用户是否可以发言
  pendingAgents: [],      // 待响应的agents列表
  needsWelcome: false,    // 是否需要欢迎新成员
  addedAgents: []         // 新增的agents列表
};

// API: 获取agents列表
app.get('/api/agents', (req, res) => {
  const config = loadOpenClawConfig();
  if (!config?.agents?.list) return res.json([]);

  const agents = config.agents.list.map(agent => {
    const identity = loadAgentIdentity(agent.id);
    return {
      id: agent.id,
      name: identity?.name || agent.name || agent.id,
      emoji: identity?.emoji || '🤖',
      workspace: agent.workspace,
      model: agent.model
    };
  });

  res.json(agents);
});

// API: 获取配置
app.get('/api/config', (req, res) => {
  const config = loadOpenClawConfig();
  if (!config) return res.json({});
  res.json(config);
});

// API: 获取群状态
app.get('/api/group/state', (req, res) => {
  res.json(groupState);
});

// API: 重置群状态
app.post('/api/group/reset', (req, res) => {
  groupState = {
    agents: [],
    lastSender: null,
    lastMessageSender: null,
    messageHistory: [],
    canUserSpeak: true,
    pendingAgents: [],
    needsWelcome: false,
    addedAgents: []
  };
  res.json({ success: true });
});

// API: 设置群里有哪些agents
app.post('/api/group/agents', (req, res) => {
  const { agentIds } = req.body;

  const config = loadOpenClawConfig();
  if (!config?.agents?.list) {
    return res.status(500).json({ error: '无法读取配置' });
  }

  // 记录原来的agents
  const oldAgentIds = groupState.agents.map(a => a.id);
  
  // 创建新的agents列表
  const newAgents = agentIds.map(id => {
    const agent = config.agents.list.find(a => a.id === id);
    const identity = loadAgentIdentity(id);
    return {
      id: id,
      name: identity?.name || agent?.name || id,
      emoji: identity?.emoji || '🤖'
    };
  });

  // 检测新增的agents
  const addedAgents = newAgents.filter(a => !oldAgentIds.includes(a.id));
  
  groupState.agents = newAgents;
  
  // 如果有新增的agents，标记需要欢迎
  if (addedAgents.length > 0) {
    groupState.canUserSpeak = false;
    groupState.needsWelcome = true;
    groupState.addedAgents = addedAgents;
    res.json({ 
      success: true, 
      agents: groupState.agents,
      needsWelcome: true,
      addedAgents: addedAgents
    });
  } else {
    groupState.canUserSpeak = true;
    res.json({ success: true, agents: groupState.agents });
  }
});

// API: 开始欢迎新成员（用户点击开始按钮后触发）- 并发执行版本
app.post('/api/group/welcome', async (req, res) => {
  const welcomeStartTime = Date.now();
  
  // 从请求中获取 agents 列表，或者从 groupState 获取
  const { agents: requestAgents } = req.body;
  let addedAgents = requestAgents || groupState.addedAgents;
  
  if (!addedAgents || addedAgents.length === 0) {
    groupState.canUserSpeak = true;
    return res.json({ success: true, message: '没有需要欢迎的成员' });
  }
  
  // 过滤掉无效的 agents
  const validAgents = addedAgents.filter(a => a && a.id);
  
  if (validAgents.length === 0) {
    groupState.canUserSpeak = true;
    return res.json({ success: true, message: '没有有效的agent需要欢迎' });
  }
  
  const totalAgents = validAgents.length;
  
  let successCount = 0;
  let errorCount = 0;
  
  groupState.pendingAgents = [...validAgents];
  groupState.needsWelcome = false;
  
  // 通知前端开始欢迎新成员
  sendWSMessage({
    type: 'welcome_start',
    addedAgents: validAgents,
    pendingCount: totalAgents
  });
  
  // 顺序执行所有Agent的欢迎任务（for循环）
  for (const agent of validAgents) {
    const safeAgentId = agent.id || `unknown_${Math.random().toString(36).substr(2, 9)}`;
    const performanceId = `welcome_${safeAgentId}_${Date.now()}`;
    
    console.log('[顺序欢迎] 开始执行:', agent.name);
    
    const result = await executeWelcomeTask(agent, performanceId);
    
    if (result.success) {
      successCount++;
      
      // 发送响应到WebSocket
      if (result.filteredResponse) {
        sendWSMessage({
          type: 'agent_response',
          agent: agent,
          response: { from: agent.name, content: result.filteredResponse },
          responses: [{ from: agent.name, content: result.filteredResponse }],
          done: false
        });
      }
    } else {
      errorCount++;
      console.error(`[顺序欢迎] Agent ${agent.name} 执行失败:`, result.error);
    }
  }
  
  // 资源清理 - 清理性能监控数据
  performanceMonitor.clear();
  
  // 更新groupState
  groupState.pendingAgents = [];
  groupState.canUserSpeak = true;
  
  const welcomeDuration = Date.now() - welcomeStartTime;
  console.log(`[顺序欢迎] 完成: 总数=${totalAgents}, 成功=${successCount}, 失败=${errorCount}, 耗时=${welcomeDuration}ms`);
  
  // 通知前端欢迎完成
  sendWSMessage({
    type: 'welcome_done',
    canUserSpeak: true,
    summary: {
      total: totalAgents,
      success: successCount,
      error: errorCount,
      duration: welcomeDuration
    }
  });
  
  res.json({ 
    success: true, 
    welcoming: true, 
    addedAgents: validAgents,
    summary: {
      total: totalAgents,
      success: successCount,
      error: errorCount,
      duration: welcomeDuration
    }
  });
});

// API: 发送消息到随机agent并获取响应
app.post('/api/group/message', async (req, res) => {
  const { content, fromUser } = req.body;

  if (!content) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  if (!groupState.canUserSpeak) {
    return res.status(403).json({ error: '请等待agent欢迎完毕后再发言' });
  }

  if (groupState.agents.length === 0) {
    return res.status(400).json({ error: '群里没有agent' });
  }

  // 随机选择一个agent接收消息（排除上一个发送响应的agent）
  // 获取上一个发送者的名字（排除用）
  const lastSenderName = groupState.lastMessageSender?.name;
  let availableAgents = groupState.agents.filter(a => a.name !== lastSenderName);
  if (availableAgents.length === 0) {
    availableAgents = groupState.agents;
  }

  var randomAgent = availableAgents[Math.floor(Math.random() * availableAgents.length)];
  var lastrandomAgent = randomAgent
  // 构建发送给agent的消息
  const messageToSend = content;

  console.log(`[群消息] 随机选中 ${randomAgent.name} (${randomAgent.id})`);
  console.log(`[消息内容] ${messageToSend}`);

  // 使用OpenClaw CLI命令发送消息给agent
  let agentResponse = '';
  try {
     const xfollowUpMessage = `"有人在群里说 ${messageToSend}，你怎么回应,200字以内,不包含动作和表情"`;

    const command = `openclaw agent --agent ${randomAgent.id} --message ${xfollowUpMessage} --deliver`;
    console.log('[执行命令]', command);

    const { stdout, stderr } = await execAsync(command, {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    });

    if (stdout) {
      console.log('[CLI输出]', stdout);
      agentResponse = stdout.trim();
      
      // 如果响应包含 completed，重试一次
      if (agentResponse.toLowerCase().includes('completed')) {
        console.log('[CLI输出包含completed，重试一次]');
        try {
          const retryResult = await execAsync(command, {
            encoding: 'utf-8',
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024
          });
          agentResponse = retryResult.stdout ? retryResult.stdout.trim() : agentResponse;
          console.log('[CLI重试输出]', agentResponse);
        } catch (retryError) {
          console.error('[CLI重试失败]', retryError.message);
        }
      }
    }
    if (stderr) {
      console.error('[CLI错误]', stderr);
    }
  } catch (error) {
    console.error('[调用Agent失败]', error.message);
  }

  console.log('[Agent响应]', agentResponse);

  const allResponses = [{ from: randomAgent.name, content: filterResponse(agentResponse) }];
  let lastSenderForFollowUp = randomAgent.name;

  groupState.lastSender = randomAgent.id;
  groupState.lastMessageSender = { name: randomAgent.name, type: 'agent' };
  groupState.messageHistory.push({
    from: fromUser || '用户',
    to: randomAgent.id,
    content,
    responses: allResponses,
    timestamp: new Date().toISOString()
  });

  if (agentResponse && agentResponse.trim()) {
    sendWSMessage({
      type: 'agent_response',
      agent: randomAgent,
      response: { from: randomAgent.name, content: filterResponse(agentResponse) },
      responses: allResponses,
      done: false
    });
  }

  let currentMessage = agentResponse;
  let shouldContinue = true;
  let loopCount = 0;
  var maxLoops = 1;

  while (shouldContinue && loopCount < maxLoops) {
    loopCount++;
    lastSenderForFollowUp = randomAgent.name;
    
    if (content.includes('结束')) {
      shouldContinue = false;
      break;
    }

    // 过滤当前消息，移除包含completed的行
    currentMessage = filterResponse(currentMessage);
    
    const followUpMessage = `"${lastSenderForFollowUp}在群里说 ${currentMessage}，你怎么回应,200字以内,不包含动作和表情"`;
    console.log(`[跟进消息 ${loopCount}]`, followUpMessage);

    while (randomAgent.name === lastSenderForFollowUp && groupState.agents.length > 1) {
      randomAgent = groupState.agents[Math.floor(Math.random() * groupState.agents.length)];
    }

    console.log(`[群消息] 随机选中 ${randomAgent.name} (${randomAgent.id})`);
    let followUpResponse = '';
    try {
      const command = `openclaw agent --agent ${randomAgent.id} --message ${followUpMessage} --deliver`;
      console.log(`[执行跟进命令 ${loopCount}]`, command);

      const { stdout, stderr } = await execAsync(command, {
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });

      if (stdout) {
        console.log(`[CLI跟进输出 ${loopCount}]`, stdout);
        followUpResponse = stdout.trim();
        
        // 如果响应包含 completed，重试一次
        if (followUpResponse.toLowerCase().includes('completed')) {
          console.log(`[CLI跟进输出包含completed，重试一次 ${loopCount}]`);
          try {
            const retryResult = await execAsync(command, {
              encoding: 'utf-8',
              timeout: 120000,
              maxBuffer: 10 * 1024 * 1024
            });
            followUpResponse = retryResult.stdout ? retryResult.stdout.trim() : followUpResponse;
            console.log(`[CLI跟进重试输出 ${loopCount}]`, followUpResponse);
          } catch (retryError) {
            console.error(`[CLI跟进重试失败 ${loopCount}]`, retryError.message);
          }
        }
      }
      if (stderr) {
        console.error(`[CLI跟进错误 ${loopCount}]`, stderr);
      }
    } catch (error) {
      console.error('[调用跟进Agent失败]', error.message);
    }

    if (followUpResponse && followUpResponse.includes('结束')) {
      allResponses.push({ from: randomAgent.name, content: filterResponse(followUpResponse.replace(/.*结束.*/g, '').trim() || followUpResponse) });
      sendWSMessage({
        type: 'agent_response',
        agent: randomAgent,
        response: allResponses[allResponses.length - 1],
        responses: allResponses,
        done: true
      });
      shouldContinue = false;
    } else if (followUpResponse && followUpResponse.trim()) {
      allResponses.push({ from: randomAgent.name, content: filterResponse(followUpResponse) });
      sendWSMessage({
        type: 'agent_response',
        agent: randomAgent,
        response: allResponses[allResponses.length - 1],
        responses: allResponses,
        done: false
      });
      currentMessage = filterResponse(followUpResponse);
      //lastSenderForFollowUp = randomAgent.name;
    } else {
      shouldContinue = false;
    }
  }
   loopCount = 0;
  var maxLoops = 300;

  var lastlastSenderForFollowUp=lastSenderForFollowUp
  while (shouldContinue && loopCount < maxLoops) {
    loopCount++;
    lastlastSenderForFollowUp=lastSenderForFollowUp
    lastSenderForFollowUp = randomAgent.name;
    
    if (content.includes('结束')) {
      shouldContinue = false;
      break;
    }

    const followUpMessage = `"${lastSenderForFollowUp}在群里回应${lastlastSenderForFollowUp}说 ${currentMessage}，你怎么回应,200字以内,不包含动作和表情"`;
    console.log(`[跟进消息 ${loopCount}]`, followUpMessage);

    while (randomAgent.name === lastSenderForFollowUp && groupState.agents.length > 1) {
      randomAgent = groupState.agents[Math.floor(Math.random() * groupState.agents.length)];
    }

    console.log(`[群消息] 随机选中 ${randomAgent.name} (${randomAgent.id})`);
    let followUpResponse = '';
    try {
      const command = `openclaw agent --agent ${randomAgent.id} --message ${followUpMessage} --deliver`;
      console.log(`[执行跟进命令 ${loopCount}]`, command);

      const { stdout, stderr } = await execAsync(command, {
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });

      if (stdout) {
        console.log(`[CLI跟进输出 ${loopCount}]`, stdout);
        followUpResponse = stdout.trim();
        
        // 如果响应包含 completed，重试一次
        if (followUpResponse.toLowerCase().includes('completed')) {
          console.log(`[CLI跟进输出包含completed，重试一次 ${loopCount}]`);
          try {
            const retryResult = await execAsync(command, {
              encoding: 'utf-8',
              timeout: 120000,
              maxBuffer: 10 * 1024 * 1024
            });
            followUpResponse = retryResult.stdout ? retryResult.stdout.trim() : followUpResponse;
            console.log(`[CLI跟进重试输出 ${loopCount}]`, followUpResponse);
          } catch (retryError) {
            console.error(`[CLI跟进重试失败 ${loopCount}]`, retryError.message);
          }
        }
      }
      if (stderr) {
        console.error(`[CLI跟进错误 ${loopCount}]`, stderr);
      }
    } catch (error) {
      console.error('[调用跟进Agent失败]', error.message);
    }

    if (followUpResponse && followUpResponse.includes('结束')) {
      allResponses.push({ from: randomAgent.name, content: filterResponse(followUpResponse.replace(/.*结束.*/g, '').trim() || followUpResponse) });
      sendWSMessage({
        type: 'agent_response',
        agent: randomAgent,
        response: allResponses[allResponses.length - 1],
        responses: allResponses,
        done: true
      });
      shouldContinue = false;
    } else if (followUpResponse && followUpResponse.trim()) {
      allResponses.push({ from: randomAgent.name, content: filterResponse(followUpResponse) });
      sendWSMessage({
        type: 'agent_response',
        agent: randomAgent,
        response: allResponses[allResponses.length - 1],
        responses: allResponses,
        done: false
      });
      currentMessage = followUpResponse;
      //lastSenderForFollowUp = randomAgent.name;
    } else {
      shouldContinue = false;
    }
  }



  /* res.json({
    success: true,
    toAgent: randomAgent,
    responses: allResponses,
    history: groupState.messageHistory
  });  */

});

// API: 模仿表演
app.post('/api/game/imitate', async (req, res) => {
  const { agentId, target, topic, performerName } = req.body;
  
  if (!agentId || !target || !topic) {
    return res.json({ success: false, error: '缺少必要参数' });
  }
  
  try {
    const message = `"请用${target}的语气和风格，模仿${target}的口吻，可以带点原来人物的特色，围绕"${topic}"这个话题，发表一段100字以内的模仿言论。不要包含动作描述。"`;
    const command = `openclaw agent --agent ${agentId} --message ${message} --deliver`;
    console.log('[模仿表演]', command);
    
    const { stdout, stderr } = await execAsync(command, {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    });
    
    let response = stdout ? stdout.trim() : '';
    
    // 如果返回completed，重试
    if (response.toLowerCase().includes('completed')) {
      console.log('[模仿表演返回completed，重试]');
      const retryResult = await execAsync(command, {
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      response = retryResult.stdout ? retryResult.stdout.trim() : response;
    }
    
    res.json({ success: true, response });
  } catch (error) {
    console.error('[模仿表演失败]', error.message);
    res.json({ success: false, error: error.message });
  }
});

// API: 评分
app.post('/api/game/score', async (req, res) => {
  const { scorerId, targetId, targetName, scorerName, target, topic, performance } = req.body;
  
  if (!scorerId || !targetId) {
    return res.json({ success: false, error: '缺少必要参数' });
  }
  
  try {
    let message;
    if (performance && performance.trim()) {
      message = `"请评价${scorerName}模仿${target}谈论"${topic}"的表演：\n\n表演内容：${performance}\n\n请从0-10分打分，只输出数字分数，0分最差，10分最好，不需要其他内容。"`;
    } else {
      message = `"请评价${scorerName}模仿${target}谈论"${topic}"的表现，从0-10分打分，只输出数字分数，不需要其他内容。"`;
    }
    
    const command = `openclaw agent --agent ${scorerId} --message ${message} --deliver`;
    console.log('[评分]', command);
    
    const { stdout, stderr } = await execAsync(command, {
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    });
    
    let response = stdout ? stdout.trim() : '';
    
    // 提取数字分数
    const scoreMatch = response.match(/\d+/);
    let score = scoreMatch ? parseInt(scoreMatch[0], 10) : 5;
    
    // 确保分数在0-10范围内
    if (score > 10) score = 10;
    if (score < 0) score = 0;
    
    // 如果返回completed，重试
    if (response.toLowerCase().includes('completed')) {
      console.log('[评分返回completed，重试]');
      const retryResult = await execAsync(command, {
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024
      });
      response = retryResult.stdout ? retryResult.stdout.trim() : response;
      const retryScoreMatch = response.match(/\d+/);
      score = retryScoreMatch ? parseInt(retryScoreMatch[0], 10) : score;
      if (score > 10) score = 10;
      if (score < 0) score = 0;
    }
    
    console.log(`[评分结果] ${scorerName} 给 ${targetName} 打分: ${score}`);
    
    res.json({ success: true, score });
  } catch (error) {
    console.error('[评分失败]', error.message);
    res.json({ success: false, error: error.message, score: 5 });
  }
});

// 静态文件
app.use(express.static('.'));

server.listen(PORT, () => {
  console.log(`💬 QQ群聊 - OpenClaw Agents`);
  console.log(`🌐 访问 http://localhost:${PORT}`);
});
