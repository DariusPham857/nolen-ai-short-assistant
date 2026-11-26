import 'dotenv/config';
import { checkFreePlannerPreflight } from '../stories/free-planner.js';

async function main() {
  const result = await checkFreePlannerPreflight();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) {
    process.exitCode = 1;
  }
}

void main();
