import 'dotenv/config';
import { runPlannerSmoke } from '../stories/planner-smoke.js';

async function main() {
  const { exitCode, summary } = await runPlannerSmoke(process.argv.slice(2));
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = exitCode;
}

void main();
