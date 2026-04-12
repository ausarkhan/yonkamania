declare global {
  interface BunServer {
    hostname: string;
    port: number;
  }

  interface BunServeOptions {
    fetch(request: Request): Response | Promise<Response>;
    hostname?: string;
    port?: number;
    error?(error: Error): Response | Promise<Response>;
  }

  const Bun: {
    serve(options: BunServeOptions): BunServer;
  };
}

export {};
