// One shared observer for every studio card. Hundreds of community companies
// must not each allocate their own IntersectionObserver instance.
let sharedObserver;
const listeners = new WeakMap();

export function whenNearViewport(element, reveal) {
  if (!element || typeof IntersectionObserver === 'undefined') {
    reveal();
    return () => {};
  }
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const listener = listeners.get(entry.target);
        if (listener) listener();
        sharedObserver.unobserve(entry.target);
        listeners.delete(entry.target);
      }
    }, { rootMargin: '650px 0px' });
  }
  listeners.set(element, reveal);
  sharedObserver.observe(element);
  return () => {
    sharedObserver.unobserve(element);
    listeners.delete(element);
  };
}
