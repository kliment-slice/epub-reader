import { toNextJsHandler } from "better-auth/next-js";

import { createAuth } from "@/lib/auth";

export const GET = (request: Request) =>
  toNextJsHandler(createAuth()).GET(request);

export const POST = (request: Request) =>
  toNextJsHandler(createAuth()).POST(request);
