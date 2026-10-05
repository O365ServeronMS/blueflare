import type http from "node:http";

export interface Upstream {
  host: string;
  port: number;
  up: boolean;
  inflight: number;
  agent: http.Agent;
}

export function makeUpstream(port: number, host?: string): Upstream;
export function pickUpstream(upstreams: Upstream[], start?: number): Upstream | null;
export function createBalancer(upstreams: Upstream[]): http.Server;
