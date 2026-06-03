import type { HttpModuleOptions } from "@nestjs/axios";
import axios from "axios";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

import type { HttpAgentEnvConfig } from "../../modules/config/config.service";

export interface KeepAliveAgentOptions {
  httpAgent?: HttpAgent;
  httpsAgent?: HttpsAgent;
}

export function createKeepAliveAgentOptions(
  config: HttpAgentEnvConfig,
): KeepAliveAgentOptions {
  if (!config.keepAliveEnabled) {
    return {};
  }

  const shared = {
    keepAlive: true,
    maxSockets: config.maxSockets,
    maxFreeSockets: config.maxFreeSockets,
    timeout: config.timeoutMs,
  };

  return {
    httpAgent: new HttpAgent(shared),
    httpsAgent: new HttpsAgent(shared),
  };
}

export function withKeepAliveAgents<T extends HttpModuleOptions>(
  options: T,
  config: HttpAgentEnvConfig,
): T {
  return {
    ...options,
    ...createKeepAliveAgentOptions(config),
  };
}

export function configureAxiosKeepAliveDefaults(config: HttpAgentEnvConfig) {
  const agents = createKeepAliveAgentOptions(config);
  if (agents.httpAgent) {
    axios.defaults.httpAgent = agents.httpAgent;
  }
  if (agents.httpsAgent) {
    axios.defaults.httpsAgent = agents.httpsAgent;
  }
}
