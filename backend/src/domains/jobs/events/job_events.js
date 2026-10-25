function subscribe(manager, jobId, listener) {
  const channel = `job:${jobId}`;
  manager.events.on(channel, listener);
  return () => manager.events.off(channel, listener);
}

function subscribeAll(manager, listener) {
  manager.events.on("jobs", listener);
  return () => manager.events.off("jobs", listener);
}

function emitJobEvent(manager, jobId, type, payload) {
  const createdAt = new Date().toISOString();
  manager.store.addEvent(jobId, type, payload, createdAt);
  const message = {
    type,
    payload,
    createdAt,
    job: manager.toJobSummary(manager.store.getJob(jobId)),
  };
  manager.events.emit(`job:${jobId}`, message);
  manager.events.emit("jobs", { kind: "job", ...message });
}

function emitJobListUpdate(manager, type, payload, job) {
  manager.events.emit("jobs", {
    kind: "job",
    type,
    payload,
    job: manager.toJobSummary(job),
    createdAt: new Date().toISOString(),
  });
}

function publishSystem(manager, type, payload) {
  manager.events.emit("system", { type, payload });
  manager.events.emit("jobs", {
    kind: "system",
    type,
    payload,
    createdAt: new Date().toISOString(),
  });
}

module.exports = { emitJobEvent, emitJobListUpdate, publishSystem, subscribe, subscribeAll };
