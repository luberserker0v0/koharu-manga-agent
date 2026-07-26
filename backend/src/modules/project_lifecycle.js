class ProjectLifecycleModule {
  constructor(client) {
    this.client = client;
  }

  async closeCurrentProject({ baseUrl }) {
    return this.client.closeCurrentProject(baseUrl);
  }
}

module.exports = {
  ProjectLifecycleModule,
};
