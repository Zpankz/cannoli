// The parts of the Chrome DevTools Protocol these live scripts read.

/** One entry of http://127.0.0.1:<port>/json/list. */
export interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** A CDP reply. Only the fields the scripts read are typed. */
export interface CdpResponse {
  id: number;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string } };
    data?: string;
  };
}

export type CdpParams = Record<string, unknown>;
