const https = require('https');

async function getSecurityAlerts() {
  // 动态导入 @octokit/rest
  const { Octokit } = await import('@octokit/rest');
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  
  try {
    console.log(`Fetching alerts for ${owner}/${repo}`);
    
    // 获取 Dependabot alerts
    const dependabotAlerts = await octokit.rest.dependabot.listAlertsForRepo({
      owner,
      repo,
      state: 'open',
    });

    // 获取 Code scanning alerts
    const codeAlerts = await octokit.rest.codeScanning.listAlertsForRepo({
      owner,
      repo,
      state: 'open',
    });

    return {
      dependabot: dependabotAlerts.data,
      codeScanning: codeAlerts.data,
    };
  } catch (error) {
    console.error('Error fetching alerts:', error.message);
    // 如果API调用失败，返回空数组而不是报错
    return { dependabot: [], codeScanning: [] };
  }
}

async function sendToMattermost(payload) {
  const webhookUrl = process.env.MATTERMOST_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.log('MATTERMOST_WEBHOOK_URL not set, skipping notification');
    return;
  }
  
  const url = new URL(webhookUrl);
  const data = JSON.stringify(payload);
  
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log(`Mattermost response status: ${res.statusCode}`);
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.statusCode);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('Request error:', error);
      reject(error);
    });
    
    req.write(data);
    req.end();
  });
}

function getSeverityEmoji(severity) {
  const emojis = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    moderate: '🟡',
    low: '🟢',
    info: '🔵'
  };
  return emojis[severity?.toLowerCase()] || '⚪';
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  
  console.log('Starting security alert check...');
  console.log(`Repository: ${repository}`);
  
  const alerts = await getSecurityAlerts();
  
  const dependabotCount = alerts.dependabot.length;
  const codeCount = alerts.codeScanning.length;
  const totalAlerts = dependabotCount + codeCount;
  
  console.log(`Found ${dependabotCount} Dependabot alerts and ${codeCount} code scanning alerts`);
  
  // 统计严重程度
  const dependabotSeverity = alerts.dependabot.reduce((acc, alert) => {
    const severity = alert.security_vulnerability?.severity || 'unknown';
    acc[severity] = (acc[severity] || 0) + 1;
    return acc;
  }, {});
  
  const codeSeverity = alerts.codeScanning.reduce((acc, alert) => {
    const severity = alert.rule?.security_severity_level || alert.rule?.severity || 'unknown';
    acc[severity] = (acc[severity] || 0) + 1;
    return acc;
  }, {});
  
  // 确定整体状态
  let status = '✅ 无安全问题';
  let color = '#00FF00';
  
  const criticalCount = (dependabotSeverity.critical || 0) + (codeSeverity.critical || 0);
  const highCount = (dependabotSeverity.high || 0) + (codeSeverity.high || 0);
  
  if (criticalCount > 0) {
    status = '🔴 发现严重安全问题';
    color = '#FF0000';
  } else if (highCount > 0) {
    status = '🟠 发现高危安全问题';
    color = '#FF8C00';
  } else if (totalAlerts > 0) {
    status = '🟡 发现安全问题';
    color = '#FFD700';
  }
  
  const attachments = [
    {
      color: color,
      title: `🛡️ 安全扫描摘要 - ${repository}`,
      fields: [
        {
          title: '仓库',
          value: repository,
          short: true
        },
        {
          title: '总告警数',
          value: totalAlerts.toString(),
          short: true
        },
        {
          title: '依赖漏洞',
          value: dependabotCount.toString(),
          short: true
        },
        {
          title: '代码扫描',
          value: codeCount.toString(),
          short: true
        }
      ],
      footer: 'GitHub 安全扫描',
      ts: Math.floor(Date.now() / 1000)
    }
  ];
  
  // 添加 Dependabot 详情
  if (dependabotCount > 0) {
    const dependabotFields = Object.entries(dependabotSeverity).map(([severity, count]) => ({
      title: `${getSeverityEmoji(severity)} ${severity.toUpperCase()}`,
      value: count.toString(),
      short: true
    }));
    
    attachments.push({
      color: '#0366d6',
      title: '📦 依赖漏洞告警',
      fields: dependabotFields,
      text: `查看详情: https://github.com/${repository}/security/dependabot`
    });
  }
  
  // 添加 Code Scanning 详情
  if (codeCount > 0) {
    const codeFields = Object.entries(codeSeverity).map(([severity, count]) => ({
      title: `${getSeverityEmoji(severity)} ${severity.toUpperCase()}`,
      value: count.toString(),
      short: true
    }));
    
    attachments.push({
      color: '#28a745',
      title: '🔍 代码扫描告警',
      fields: codeFields,
      text: `查看详情: https://github.com/${repository}/security/code-scanning`
    });
  }
  
  const payload = {
    username: 'GitHub 安全扫描',
    icon_emoji: ':shield:',
    text: `## ${status}`,
    attachments: attachments
  };
  
  try {
    await sendToMattermost(payload);
    console.log('安全告警已成功发送到 Mattermost');
  } catch (error) {
    console.error('发送到 Mattermost 失败:', error);
    // 不要因为通知失败而让整个工作流失败
  }
}

main().catch(error => {
  console.error('脚本执行失败:', error);
  // 不退出进程，避免工作流失败
});
