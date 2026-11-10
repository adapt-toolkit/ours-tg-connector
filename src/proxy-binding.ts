// Proxy-agent binding for a route (cfg.peerCid).
//
// The route's proxy agent is the one contact its identity has. A route binds it
// once, from the authenticated daemon contact list, never from an event payload,
// a name or command arguments:
//   - a configured non-empty binding is never changed;
//   - exactly one contact with a well-formed container id binds it;
//   - zero or several contacts, a malformed id, a list error or a write error
//     leave the route unbound (widget commands refuse; ordinary messages keep
//     their existing fallback), and the next trigger re-evaluates.
// The binding is written to disk before it becomes visible in memory, and
// evaluations are serialized per route, so a racing contact event can never
// replace the first durable binding.
//
// Triggers: route restore (covers legacy routes created before the binding was
// recorded, or whose contact event was missed) and every contact-added event.

export const CONTAINER_ID = /^[0-9A-F]{64}$/;

export interface ProxyBindingDeps {
  current(): string; // the in-memory binding ('' when unbound)
  listContacts(): Promise<Array<{ name: string; container_id: string }>>;
  persist(peerCid: string): void; // durable write of the route metadata with this binding; throws on failure
  commit(peerCid: string): void; // expose the binding in memory (after persist succeeded)
  log(msg: string): void;
}

export type BindOutcome = 'bound' | 'kept' | 'none' | 'ambiguous' | 'invalid' | 'error';

export function makeProxyBinder(deps: ProxyBindingDeps): (reason: string) => Promise<BindOutcome> {
  let chain: Promise<unknown> = Promise.resolve();
  const evaluate = async (reason: string): Promise<BindOutcome> => {
    if (deps.current()) return 'kept';
    let contacts: Array<{ name: string; container_id: string }>;
    try {
      contacts = await deps.listContacts();
    } catch (err) {
      deps.log(`proxy agent not bound (${reason}): listing contacts failed: ${String(err)}`);
      return 'error';
    }
    // A concurrent evaluation may have bound it while we waited.
    if (deps.current()) return 'kept';
    if (contacts.length === 0) return 'none';
    if (contacts.length > 1) {
      deps.log(`proxy agent not bound (${reason}): the route has ${contacts.length} contacts; widgets stay unavailable until exactly one remains`);
      return 'ambiguous';
    }
    const [only] = contacts;
    if (typeof only.container_id !== 'string' || !CONTAINER_ID.test(only.container_id)) {
      deps.log(`proxy agent not bound (${reason}): the only contact has a malformed container id`);
      return 'invalid';
    }
    try {
      deps.persist(only.container_id);
    } catch (err) {
      deps.log(`proxy agent not bound (${reason}): saving the binding failed: ${String(err)}`);
      return 'error';
    }
    deps.commit(only.container_id);
    deps.log(`proxy agent bound (${reason}): "${only.name}" (${only.container_id})`);
    return 'bound';
  };
  return (reason) => {
    const run = chain.then(() => evaluate(reason));
    chain = run.catch(() => undefined);
    return run;
  };
}
