import assert from 'node:assert/strict';

import { singleFlight } from '../src/single-flight.ts';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

console.log('=== concurrent message_received wakes are single-flight per route ===');
{
  const firstPass = deferred();
  let passes = 0;
  let active = 0;
  let maxActive = 0;
  const routeDrain = singleFlight(async () => {
    passes += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (passes === 1) await firstPass.promise;
    active -= 1;
  });

  const wake1 = routeDrain();
  const wake2 = routeDrain();
  const wake3 = routeDrain();
  firstPass.resolve();
  await Promise.all([wake1, wake2, wake3]);

  assert.equal(maxActive, 1, 'one route never runs overlapping drains');
  assert.equal(passes, 2, 'wakes during the active pass coalesce into one follow-up pass');
}

console.log('=== separate routes keep independent flights ===');
{
  const gate = deferred();
  let active = 0;
  let globalMax = 0;
  const makeRoute = () => singleFlight(async () => {
    active += 1;
    globalMax = Math.max(globalMax, active);
    await gate.promise;
    active -= 1;
  });
  const routeA = makeRoute();
  const routeB = makeRoute();
  const a = routeA();
  const b = routeB();
  await Promise.resolve();
  assert.equal(globalMax, 2, 'different routes may drain concurrently');
  gate.resolve();
  await Promise.all([a, b]);
}

console.log('single-flight OK');
