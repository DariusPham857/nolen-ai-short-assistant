import { runtimeConfig } from '@nolen/server/runtime';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Fail before Next binds a port; instrumentation remains a second runtime check.
runtimeConfig();
const child=spawn(process.execPath,[fileURLToPath(import.meta.resolve('next/dist/bin/next')),'start','--hostname',process.env.WEB_HOST ?? '127.0.0.1',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code??1;});
child.on('error',()=>{console.error('Web startup failed');process.exitCode=1;});
