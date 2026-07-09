// Fork 更新：合并上游最新代码 → 重建面板镜像 → 重新部署面板。
// 面板自身在容器内，无法直接操作宿主 git 仓库，故派生一个临时 alpine helper 容器，
// 挂载 docker.sock + 宿主仓库目录，在 helper 中执行：
//   git fetch upstream → git merge upstream/main → docker build → docker compose up -d panel
// helper 完成后面板被重建、自动重启。失败时面板容器仍在旧镜像上（docker compose up -d
// 会用本地最新构建结果；若构建失败则无新镜像，compose 会保留旧容器不动）。

import Docker from 'dockerode';
import { appendPanelLog } from './logs.js';

const docker = new Docker();
const PANEL_NAME = process.env.WOC_PANEL_CONTAINER || 'woc-panel';
const UPDATER_NAME = PANEL_NAME + '-fork-updater';
const REPO_HOST_PATH = process.env.WOC_REPO_PATH || '/home/rogerwi/woc';
// helper 容器需走宿主代理访问 github（bridge 网络 127.0.0.1 不通宿主代理，故用 host 网络 + 传 env）
const PROXY = process.env.WOC_PROXY || 'http://127.0.0.1:7890';

let updateInFlight = false;

export async function triggerForkUpdate(): Promise<{ message: string }> {
  if (updateInFlight) throw new Error('Fork 更新正在进行中，请稍候');
  updateInFlight = true;
  try {
    return await doForkUpdate();
  } catch (e) {
    updateInFlight = false;
    throw e;
  }
}

async function doForkUpdate(): Promise<{ message: string }> {
  const self: any = await docker.getContainer(PANEL_NAME).inspect();

  const spec = { panelName: PANEL_NAME };

  // 获取 docker.sock 挂载路径
  const sockBind =
    (self.HostConfig.Binds || []).find((b: string) => b.includes('docker.sock'))
    || '/var/run/docker.sock:/var/run/docker.sock';

  // 清理旧 helper
  try { await docker.getContainer(UPDATER_NAME).remove({ force: true }); } catch { /* 无旧 helper */ }

  appendPanelLog('WARN', `Fork 更新：启动 helper ${UPDATER_NAME}（合并上游 + 重建）`);

  const helper = await docker.createContainer({
    name: UPDATER_NAME,
    Image: 'alpine:3.19',
    Env: [
      'DOCKER_BUILDKIT=1',
      'WOC_UPDATER_SPEC=' + JSON.stringify(spec),
      'WOC_REPO_PATH=' + REPO_HOST_PATH,
      // 代理（host 网络下 127.0.0.1 直达宿主 clash）—— git fetch/push 访问 github 走代理
      'HTTP_PROXY=' + PROXY,
      'HTTPS_PROXY=' + PROXY,
      'NO_PROXY=localhost,127.0.0.1,::1',
    ],
    Cmd: [
      '/bin/sh', '-c',
      "sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && apk add --no-cache docker-cli docker-cli-buildx git jq bash && "
      + `bash ${REPO_HOST_PATH}/scripts/fork-update.sh`,
    ],
    HostConfig: {
      Binds: [
        sockBind,
        `${REPO_HOST_PATH}:${REPO_HOST_PATH}`,
        // fork 自动 push 需要 GITHUB_TOKEN（宿主 /etc/environment，只读挂载）
        '/etc/environment:/etc/environment:ro',
      ],
      // host 网络：helper 内 127.0.0.1 直达宿主代理（bridge 下 127.0.0.1 是容器自己，代理传不进）
      NetworkMode: 'host',
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
    },
  });

  await helper.start();
  appendPanelLog('INFO', `Fork 更新：helper ${UPDATER_NAME} 已启动`);

  return {
    message: 'Fork 更新已启动：正在合并上游代码并重建面板镜像，预计 1-3 分钟，完成后面板将自动重启。',
  };
}

// 查询 fork 更新 helper 的状态（供前端轮询）
export type ForkUpdateStatus =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'success'; version?: string }
  | { status: 'conflict'; message: string }
  | { status: 'failed'; code: number; message: string };

export async function forkUpdateStatus(): Promise<ForkUpdateStatus> {
  try {
    const info: any = await docker.getContainer(UPDATER_NAME).inspect();
    const s = info.State || {};
    if (s.Running) return { status: 'running' };

    // helper 已退出（成功/失败/冲突）→ 复位锁，允许下次触发（修复：helper 失败且不重建面板时，锁曾永久卡死）
    updateInFlight = false;

    const code = s.ExitCode || 0;
    // 读取最后几行日志获取详细信息
    let tail = '';
    try {
      const logs = await docker.getContainer(UPDATER_NAME).logs({ stdout: true, stderr: true, tail: 30 });
      tail = Buffer.isBuffer(logs) ? logs.toString('utf-8') : String(logs);
    } catch { /* ignore */ }

    const pickVersion = (s: string) => {
      const m = s.match(/version: (v\S+)/);
      return m ? m[1] : undefined;
    };

    if (code === 0) {
      return { status: 'success', version: pickVersion(tail) };
    }
    const lastError = tail.split('\n').reverse().find(l => l.includes('ERROR')) || '未知错误';
    if (code === 2) {
      return { status: 'conflict', message: '合并冲突：上游代码与本地修改有冲突，需手动解决' };
    }
    return { status: 'failed', code, message: lastError };
  } catch {
    return { status: 'idle' };
  }
}
