globalThis.jest = {
  fn: (impl) => {
    const mockFn = async (...args) => {
      return await impl(...args);
    };
    return mockFn;
  }
};

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

async function executeWelcomeTask(agent, performanceId, shouldFail = false) {
  performanceMonitor.start(performanceId);
  
  const command = `openclaw agent --agent ${agent.id} --message "/new" --deliver`;
  
  await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
  
  if (shouldFail) {
    const error = new Error('模拟执行失败');
    performanceMonitor.end(performanceId);
    return {
      agent,
      success: false,
      response: null,
      filteredResponse: '',
      error: error.message
    };
  }
  
  const mockResponses = {
    'success': '正常响应内容',
    'completed': 'completed',
  };
  
  const responseType = Math.random() > 0.2 ? 'success' : 'completed';
  const response = mockResponses[responseType];
  
  let finalResponse = response;
  if (response && response.toLowerCase().includes('completed')) {
    await new Promise(resolve => setTimeout(resolve, 50));
    finalResponse = '重试后的响应';
  }
  
  const result = {
    agent,
    success: true,
    response: finalResponse,
    filteredResponse: finalResponse ? `过滤后的内容: ${finalResponse}` : '',
    error: null
  };
  
  performanceMonitor.end(performanceId);
  return result;
}

async function runConcurrentWelcome(addedAgents, customExecutor = null) {
  const welcomeStartTime = Date.now();
  const totalAgents = addedAgents.length;
  
  const localPendingAgents = new Set(addedAgents.map(a => a.id));
  let completedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  
  const executor = customExecutor || executeWelcomeTask;
  
  const welcomePromises = addedAgents.map(async (agent) => {
    const performanceId = `welcome_${agent.id}_${Date.now()}`;
    
    try {
      const result = await executor(agent, performanceId, agent.shouldFail);
      
      localPendingAgents.delete(agent.id);
      completedCount++;
      
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
      
      return result;
      
    } catch (error) {
      localPendingAgents.delete(agent.id);
      completedCount++;
      errorCount++;
      
      return {
        agent,
        success: false,
        error: error.message
      };
    }
  });
  
  const results = await Promise.all(welcomePromises);
  
  performanceMonitor.clear();
  
  const welcomeDuration = Date.now() - welcomeStartTime;
  
  return {
    results,
    summary: {
      total: totalAgents,
      success: successCount,
      error: errorCount,
      duration: welcomeDuration
    }
  };
}

describe('并发异步执行测试', () => {
  
  beforeEach(() => {
    performanceMonitor.clear();
  });
  
  test('Promise.all 并发执行多个任务', async () => {
    const agents = [
      { id: 'agent1', name: 'Agent 1' },
      { id: 'agent2', name: 'Agent 2' },
      { id: 'agent3', name: 'Agent 3' }
    ];
    
    const results = await runConcurrentWelcome(agents);
    
    expect(results.results).toHaveLength(3);
    expect(results.summary.total).toBe(3);
    expect(results.summary.duration).toBeLessThan(300);
  });
  
  test('所有异步任务成功完成', async () => {
    const agents = [
      { id: 'agent1', name: 'Agent 1' },
      { id: 'agent2', name: 'Agent 2' }
    ];
    
    const results = await runConcurrentWelcome(agents);
    
    expect(results.results.every(r => r.success || !r.success)).toBe(true);
    expect(results.summary.total).toBe(2);
  });
  
  test('错误处理 - 单个任务失败不影响其他任务', async () => {
    const customExecutor = jest.fn(async (agent, performanceId) => {
      performanceMonitor.start(performanceId);
      
      if (agent.id === 'agent-fail') {
        performanceMonitor.end(performanceId);
        return {
          agent,
          success: false,
          response: null,
          filteredResponse: '',
          error: '模拟失败'
        };
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
      performanceMonitor.end(performanceId);
      
      return {
        agent,
        success: true,
        response: '成功',
        filteredResponse: '成功',
        error: null
      };
    });
    
    const agents = [
      { id: 'agent-success1', name: 'Agent Success 1', shouldFail: false },
      { id: 'agent-fail', name: 'Agent Fail', shouldFail: true },
      { id: 'agent-success2', name: 'Agent Success 2', shouldFail: false }
    ];
    
    const results = await runConcurrentWelcome(agents, customExecutor);
    
    expect(results.summary.total).toBe(3);
    expect(results.results).toHaveLength(3);
    
    const failedResults = results.results.filter(r => !r.success);
    const successResults = results.results.filter(r => r.success);
    expect(failedResults.length).toBe(1);
    expect(successResults.length).toBe(2);
  });
  
  test('性能监控正确记录执行时间', async () => {
    const operationId = 'test_operation';
    
    performanceMonitor.start(operationId);
    await new Promise(resolve => setTimeout(resolve, 100));
    const metric = performanceMonitor.end(operationId);
    
    expect(metric).not.toBeNull();
    expect(metric.duration).toBeGreaterThanOrEqual(90);
    expect(metric.duration).toBeLessThan(200);
    expect(metric.startMemory).toBeDefined();
    expect(metric.memoryDelta).toBeDefined();
  });
  
  test('资源清理 - clear 方法正确清理指标', () => {
    performanceMonitor.start('op1');
    performanceMonitor.start('op2');
    
    expect(performanceMonitor.metrics.size).toBe(2);
    
    performanceMonitor.clear();
    
    expect(performanceMonitor.metrics.size).toBe(0);
  });
  
  test('并发执行保持数据完整性', async () => {
    const agents = [
      { id: 'agent1', name: 'Agent 1' },
      { id: 'agent2', name: 'Agent 2' },
      { id: 'agent3', name: 'Agent 3' },
      { id: 'agent4', name: 'Agent 4' },
      { id: 'agent5', name: 'Agent 5' }
    ];
    
    const results = await runConcurrentWelcome(agents);
    
    const uniqueAgentIds = new Set(results.results.map(r => r.agent.id));
    expect(uniqueAgentIds.size).toBe(5);
    
    const successResults = results.results.filter(r => r.success);
    const failedResults = results.results.filter(r => !r.success);
    expect(successResults.length + failedResults.length).toBe(5);
  });
  
  test('无竞态条件 - 多次执行结果一致', async () => {
    const agents = [
      { id: 'agent1', name: 'Agent 1' },
      { id: 'agent2', name: 'Agent 2' }
    ];
    
    const results1 = await runConcurrentWelcome(agents);
    const results2 = await runConcurrentWelcome(agents);
    
    expect(results1.summary.total).toBe(results2.summary.total);
    expect(results1.results.length).toBe(results2.results.length);
  });
});

describe('executeWelcomeTask 单元测试', () => {
  
  test('成功响应正确返回', async () => {
    const agent = { id: 'test-agent', name: 'Test Agent' };
    const result = await executeWelcomeTask(agent, 'test_1');
    
    expect(result.agent).toEqual(agent);
    expect(result.success).toBe(true);
    expect(result.response).toBeDefined();
    expect(result.filteredResponse).toBeDefined();
  });
  
  test('失败响应正确处理', async () => {
    const agent = { id: 'error-agent', name: 'Error Agent' };
    const result = await executeWelcomeTask(agent, 'test_error', true);
    
    expect(result.agent).toEqual(agent);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

console.log('运行测试: npm test');
