import { config } from './config.js';

let learnedDeadHosts = [];

const matches = (hostname, list) => list.some((host) => hostname === host || hostname.endsWith('.' + host));

export function setLearnedDeadHosts(hosts) {
  learnedDeadHosts = [...hosts];
}

export function deadImageHosts() {
  return [...new Set([...config.imageDeadHosts, ...learnedDeadHosts])];
}

export function isDeadImageHost(hostname) {
  return matches(hostname, deadImageHosts());
}

export function isAllowedImageHost(hostname) {
  return matches(hostname, config.imageAllowedHosts) && !isDeadImageHost(hostname);
}
