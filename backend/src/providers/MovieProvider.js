export class ProviderSchemaError extends Error {
  constructor(provider, field) {
    super(provider + ' response is missing expected ' + field);
    this.name = 'ProviderSchemaError';
  }
}

export class MovieProvider {
  constructor(name, priority) {
    this.name = name;
    this.priority = priority;
  }

  async syncLatest() {
    throw new Error('syncLatest() must be implemented by ' + this.name);
  }

  async list() {
    throw new Error('list() must be implemented by ' + this.name);
  }

  async detail() {
    throw new Error('detail() must be implemented by ' + this.name);
  }

  async search() {
    throw new Error('search() must be implemented by ' + this.name);
  }

  async resolveStreams(slug) {
    const detail = await this.detail(slug);
    return detail.normalized?.streams || detail.streams || [];
  }

  expectArray(value, field) {
    if (!Array.isArray(value)) {
      throw new ProviderSchemaError(this.name, field);
    }
    return value;
  }
}
