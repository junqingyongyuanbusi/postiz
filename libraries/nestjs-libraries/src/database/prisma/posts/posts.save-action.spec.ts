import { BadRequestException, ConflictException } from '@nestjs/common';
import { Post, State } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { PostsRepository } from './posts.repository';
import { PostsService } from './posts.service';

jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({ ioRedis: {} }));

const createBody = (): CreatePostDto => ({
  type: 'schedule',
  saveAction: 'update',
  date: '2030-10-15T12:00:00Z',
  shortLink: false,
  tags: [],
  posts: [{
    integration: { id: 'channel-one' },
    group: 'editor-generated-group',
    settings: { __type: 'test' } as any,
    value: [{ id: 'editor-generated-id', content: 'Updated content', delay: 0, image: [] }],
  }],
});

const createStoredPost = (overrides: Partial<Post> = {}): Post => ({
  id: 'stored-root',
  organizationId: 'organization',
  integrationId: 'channel-one',
  group: 'stored-group',
  batchId: null,
  parentPostId: null,
  state: State.DRAFT,
  saveAction: null,
  publishDate: new Date('2030-10-14T12:00:00Z'),
  releaseId: null,
  releaseURL: null,
  error: null,
  deletedAt: null,
  ...overrides,
} as Post);

function createServiceFixture(targets: Post[][] = [[]]) {
  const repository = {
    validatePostTargets: jest.fn().mockResolvedValue(targets),
    getDraftWorkflowPostIds: jest.fn().mockResolvedValue(['stored-root']),
    createOrUpdatePost: jest.fn().mockResolvedValue({ posts: [{ id: 'stored-root', state: State.QUEUE }] }),
    getPostById: jest.fn().mockResolvedValue(createStoredPost()),
  };
  const workflow = {
    list: jest.fn().mockImplementation(async function* () {}),
    getHandle: jest.fn().mockReturnValue({
      describe: jest.fn().mockRejectedValue(new WorkflowNotFoundError('No workflow', 'post_stored-root')),
    }),
    start: jest.fn(),
  };
  const service = Object.assign(Object.create(PostsService.prototype), {
    _postRepository: repository,
    _integrationService: { getIntegrationById: jest.fn().mockResolvedValue({ id: 'channel-one' }) },
    _integrationManager: { getSocialIntegration: jest.fn().mockReturnValue({}) },
    _temporalService: { client: { getRawClient: () => ({ workflow }) } },
    detachStaleAnchors: jest.fn().mockResolvedValue(undefined),
  }) as PostsService;
  return { service, repository, workflow };
}

describe('post save action execution', () => {
  it('keeps schedule execution, requested date and workflow restart for the update marker', async () => {
    const { service, repository } = createServiceFixture([[createStoredPost({ state: State.QUEUE })]]);
    const startWorkflow = jest.spyOn(service, 'startWorkflow').mockResolvedValue(undefined);
    const body = createBody();
    await expect(service.createPost('organization', body, 'WEB')).resolves.toEqual([
      { postId: 'stored-root', integration: 'channel-one' },
    ]);
    expect(repository.createOrUpdatePost).toHaveBeenCalledWith(
      'schedule', 'organization', body.date, body.posts[0], [], 'WEB',
      undefined, false, expect.any(String), 'update', false
    );
    expect(startWorkflow).toHaveBeenCalledWith('test', 'stored-root', 'organization', State.QUEUE);
  });

  it.each(['invalid', '', null, 1])('rejects invalid runtime type %p before database writes', async (type) => {
    const { service, repository } = createServiceFixture();
    await expect(service.createPost('organization', { ...createBody(), type } as any, 'WEB')).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it.each([
    ['draft', 'now'], ['schedule', 'pass'], ['now', 'update'], ['update', 'draft'], ['draft', null],
  ])('rejects invalid combination %s/%s', (type, saveAction) => {
    const { service } = createServiceFixture();
    expect(() => service.getSaveAction({ type, saveAction } as any)).toThrow(BadRequestException);
  });

  it('infers missing action from the execution type', () => {
    const { service } = createServiceFixture();
    expect(service.getSaveAction({ type: 'schedule' })).toBe('schedule');
  });

  it('preserves legacy empty ids as new content rather than rejecting the save', async () => {
    const { service, repository } = createServiceFixture();
    jest.spyOn(service, 'startWorkflow').mockResolvedValue(undefined);
    const body = createBody();
    body.posts[0].value[0].id = '';
    await service.createPost('organization', body, 'WEB');
    expect(repository.createOrUpdatePost).toHaveBeenCalled();
  });

  it('omits placeholder ids from generated drafts and their link comment', async () => {
    const { service } = createServiceFixture();
    Object.assign(service, {
      _integrationService: {
        getIntegrationsList: jest.fn().mockResolvedValue([{ id: 'channel-one', providerIdentifier: 'test' }]),
      },
    });
    const createPost = jest.spyOn(service, 'createPost').mockResolvedValue([]);
    await service.generatePostsDraft('organization', {
      year: 2099, week: 40, url: 'https://example.com/story', postId: '',
      posts: [{ list: [{ post: 'Generated draft' }] }],
    });
    expect(createPost).toHaveBeenCalledTimes(1);
    const generatedValues = createPost.mock.calls[0][1].posts[0].value;
    expect(generatedValues).toHaveLength(2);
    expect(generatedValues[0].content).toBe('Generated draft');
    expect(generatedValues[1].content).toContain('https://example.com/story');
    expect(generatedValues.every((value) => !Object.prototype.hasOwnProperty.call(value, 'id'))).toBe(true);
  });

  it('passes an existing untouched draft without starting a publishing workflow', async () => {
    const { service, repository, workflow } = createServiceFixture([[createStoredPost()]]);
    const startWorkflow = jest.spyOn(service, 'startWorkflow').mockResolvedValue(undefined);
    const body = { ...createBody(), type: 'draft', saveAction: 'pass' } as CreatePostDto;
    await service.createPost('organization', body, 'WEB');
    expect(workflow.list).toHaveBeenCalled();
    expect(workflow.getHandle).toHaveBeenCalledWith('post_stored-root');
    expect(repository.createOrUpdatePost).toHaveBeenCalledWith(
      'draft', 'organization', body.date, body.posts[0], [], 'WEB',
      undefined, false, expect.any(String), 'pass', false
    );
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    { state: State.QUEUE, publishDate: new Date('2030-10-15T12:00:00Z') },
    { state: State.QUEUE, publishDate: new Date(0) },
    { state: State.ERROR },
    { state: State.PUBLISHED },
    { state: State.DRAFT, releaseId: 'pending-platform-result' },
  ])('fails closed for scheduled or uncertain pass targets %p', async (target) => {
    const { service, repository } = createServiceFixture([[createStoredPost(target)]]);
    await expect(service.createPost('organization', {
      ...createBody(), type: 'draft', saveAction: 'pass',
    }, 'WEB')).rejects.toBeInstanceOf(ConflictException);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it('does not report success when Temporal cannot confirm absence', async () => {
    const { service, repository, workflow } = createServiceFixture([[createStoredPost()]]);
    workflow.list.mockImplementation(() => { throw new Error('Unavailable'); });
    await expect(service.createPost('organization', {
      ...createBody(), type: 'draft', saveAction: 'pass',
    }, 'WEB')).rejects.toBeInstanceOf(ConflictException);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it('rejects draft workflow history, including recurring child executions', async () => {
    const { service, repository, workflow } = createServiceFixture([[createStoredPost()]]);
    workflow.list.mockImplementation(async function* () { yield { workflowId: 'recurring-child' }; });
    await expect(service.createPost('organization', {
      ...createBody(), type: 'draft', saveAction: 'pass',
    }, 'WEB')).rejects.toBeInstanceOf(ConflictException);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it('does not restart a stale queued task after pass committed', async () => {
    const { service, repository, workflow } = createServiceFixture();
    repository.getPostById.mockResolvedValue(createStoredPost({ saveAction: 'pass' }));
    await service.startWorkflow('test', 'stored-root', 'organization', State.QUEUE);
    expect(workflow.list).not.toHaveBeenCalled();
    expect(workflow.start).not.toHaveBeenCalled();
  });
});

describe('post target ownership', () => {
  function createRepositoryFixture() {
    const findMany = jest.fn().mockResolvedValue([]);
    const repository = Object.assign(Object.create(PostsRepository.prototype), {
      _post: { model: { post: { findMany } } },
    }) as PostsRepository;
    return { repository, findMany };
  }

  it('accepts a fresh editor group and temporary content id', async () => {
    const { repository } = createRepositoryFixture();
    await expect(repository.validatePostTargets('organization', createBody().posts)).resolves.toEqual([[]]);
  });

  it('accepts a shared fresh group across several new channels', async () => {
    const { repository } = createRepositoryFixture();
    const [first] = createBody().posts;
    const second = { ...first, integration: { id: 'channel-two' }, value: [{ ...first.value[0], id: 'another-temporary-id' }] };
    await expect(repository.validatePostTargets('organization', [first, second])).resolves.toEqual([[], []]);
  });

  it('rejects an existing foreign id even when a fresh group is supplied', async () => {
    const { repository, findMany } = createRepositoryFixture();
    findMany.mockResolvedValue([createStoredPost({ id: 'editor-generated-id', organizationId: 'foreign-organization' })]);
    await expect(repository.validatePostTargets('organization', createBody().posts)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a temporary new comment id alongside a persisted root', async () => {
    const { repository, findMany } = createRepositoryFixture();
    const stored = createStoredPost();
    findMany.mockResolvedValue([stored]);
    const [body] = createBody().posts;
    body.group = stored.group;
    body.value = [{ ...body.value[0], id: stored.id }, { ...body.value[0], id: 'new-comment-id' }];
    await expect(repository.validatePostTargets('organization', [body])).resolves.toEqual([[stored]]);
    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: { OR: [
        { group: stored.group, deletedAt: null },
        { id: { in: [stored.id, 'new-comment-id'] } },
      ] },
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: { organizationId: 'organization', group: stored.group, deletedAt: null },
    });
  });

  it('accepts promoting a persisted comment to the first message', async () => {
    const { repository, findMany } = createRepositoryFixture();
    const root = createStoredPost();
    const comment = createStoredPost({ id: 'stored-comment', parentPostId: root.id });
    findMany.mockResolvedValue([root, comment]);
    const [body] = createBody().posts;
    body.group = root.group;
    body.value[0].id = comment.id;
    await expect(repository.validatePostTargets('organization', [body])).resolves.toEqual([[root, comment]]);
  });

  it('accepts adding a channel using an existing same-organization placeholder group', async () => {
    const { repository, findMany } = createRepositoryFixture();
    const root = createStoredPost();
    findMany.mockResolvedValue([root]);
    const [body] = createBody().posts;
    body.integration.id = 'new-channel';
    body.group = root.group;
    await expect(repository.validatePostTargets('organization', [body])).resolves.toEqual([[]]);
  });

  it('still rejects an explicit persisted id from another channel', async () => {
    const { repository, findMany } = createRepositoryFixture();
    const root = createStoredPost();
    findMany.mockResolvedValue([root]);
    const [body] = createBody().posts;
    body.integration.id = 'new-channel';
    body.group = root.group;
    body.value[0].id = root.id;
    await expect(repository.validatePostTargets('organization', [body])).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('atomic post persistence', () => {
  function createTransactionFixture(existingPosts: Post[] = []) {
    const post = {
      findMany: jest.fn().mockResolvedValue(existingPosts),
      findFirst: jest.fn().mockResolvedValue(existingPosts.find((storedPost) => !storedPost.parentPostId) || null),
      create: jest.fn().mockImplementation(async ({ data }) => ({ ...data })),
      update: jest.fn().mockImplementation(async ({ data }) => ({ ...createStoredPost(), ...data })),
      updateMany: jest.fn().mockImplementation(async ({ where }: { where: { id: string | { in: string[] } }; data: Record<string, unknown> }) => {
        const targetIdentifiers = typeof where.id === 'string' ? [where.id] : where.id.in;
        return {
          count: existingPosts.filter((storedPost) => targetIdentifiers.includes(storedPost.id)).length,
        };
      }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(createStoredPost({ saveAction: 'pass' })),
    };
    const transaction = {
      post,
      integration: { findFirst: jest.fn().mockResolvedValue({ id: 'channel-one' }) },
      tagsPosts: { deleteMany: jest.fn() },
    };
    const runTransaction = jest.fn().mockImplementation(async (callback) => callback(transaction));
    const repository = Object.assign(Object.create(PostsRepository.prototype), {
      _transaction: { model: { $transaction: runTransaction } },
      _post: { model: { post } },
      _errors: { model: { errors: { create: jest.fn() } } },
    }) as PostsRepository;
    return { repository, post, runTransaction };
  }

  it('stores content, pass marker and DRAFT state in one serializable transaction', async () => {
    const { repository, post, runTransaction } = createTransactionFixture();
    const body = createBody();
    await repository.createOrUpdatePost('draft', 'organization', body.date, body.posts[0], [], 'WEB', undefined, false, 'batch', 'pass');
    expect(runTransaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(post.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      content: 'Updated content', state: State.DRAFT, saveAction: 'pass',
    }) });
    expect(post.update).not.toHaveBeenCalled();
  });

  it('guards an existing draft against becoming published during save', async () => {
    const stored = createStoredPost();
    const { repository, post } = createTransactionFixture([stored]);
    const body = createBody();
    body.posts[0].group = stored.group;
    body.posts[0].value[0].id = stored.id;
    await repository.createOrUpdatePost('draft', 'organization', body.date, body.posts[0], [], 'WEB', undefined, false, 'batch', 'pass');
    expect(post.update).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: stored.id, organizationId: 'organization', integrationId: 'channel-one',
        state: State.DRAFT, releaseId: null, releaseURL: null, error: null,
      }),
      data: expect.objectContaining({ state: State.DRAFT, saveAction: 'pass' }),
    }));
  });

  it('does not let a stale ERROR overwrite a passed draft', async () => {
    const { repository, post } = createTransactionFixture();
    await expect(repository.changeState('stored-root', State.ERROR, 'Already posted')).resolves.toEqual(
      expect.objectContaining({ state: State.DRAFT, saveAction: 'pass' })
    );
    expect(post.update).not.toHaveBeenCalled();
    expect(post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ saveAction: null }, { saveAction: { not: 'pass' } }, { state: { not: State.DRAFT } }],
      }),
    }));
  });

  it('records an actual PUBLISHED outcome even if a stale pass marker remains', async () => {
    const { repository, post } = createTransactionFixture();
    await repository.changeState('stored-root', State.PUBLISHED);
    expect(post.updateMany).not.toHaveBeenCalled();
    expect(post.update).toHaveBeenCalledWith(expect.objectContaining({ data: { state: State.PUBLISHED } }));
  });

  it('clears pass when the user explicitly schedules a draft again', async () => {
    const root = createStoredPost({ saveAction: 'pass' });
    const comment = createStoredPost({ id: 'stored-comment', parentPostId: root.id, saveAction: 'pass' });
    const { repository, post, runTransaction } = createTransactionFixture([root, comment]);
    await repository.changePostStatus('organization', 'stored-root', 'schedule');
    expect(runTransaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: [root.id, comment.id] }, organizationId: 'organization',
        integrationId: root.integrationId, group: root.group, deletedAt: null,
      }),
      data: { state: State.QUEUE, saveAction: 'schedule' },
    }));
  });

  it('drafts the entire unpublished thread and clears pass markers', async () => {
    const root = createStoredPost({ state: State.QUEUE });
    const comment = createStoredPost({ id: 'stored-comment', parentPostId: root.id });
    const { repository, post } = createTransactionFixture([root, comment]);
    await repository.changePostStatus('organization', root.id, 'draft');
    expect(post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [root.id, comment.id] } }),
      data: { state: State.DRAFT, saveAction: 'draft' },
    }));
  });

  it('keeps a draft thread drafted when scheduling its date and clears pass on all messages', async () => {
    const root = createStoredPost({ saveAction: 'pass' });
    const comment = createStoredPost({ id: 'stored-comment', parentPostId: root.id, saveAction: 'pass' });
    const { repository, post } = createTransactionFixture([root, comment]);
    const date = '2030-12-01T12:00:00Z';
    // The transaction must use the actual root state, not the stale boolean.
    await repository.changeDate('organization', root.id, date, false, 'schedule');
    expect(post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [root.id, comment.id] } }),
      data: { publishDate: new Date(date), state: State.DRAFT, saveAction: 'draft', releaseId: null, releaseURL: null },
    }));
  });

  it('updates dates and metadata without requeuing a published thread', async () => {
    const root = createStoredPost({ state: State.PUBLISHED, releaseId: 'platform-root' });
    const comment = createStoredPost({ id: 'stored-comment', parentPostId: root.id, state: State.PUBLISHED, releaseId: 'platform-comment' });
    const { repository, post } = createTransactionFixture([root, comment]);
    const date = '2030-12-01T12:00:00Z';
    await repository.changeDate('organization', root.id, date, false, 'update');
    expect(post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { publishDate: new Date(date), saveAction: 'update' },
    }));
  });

  it('reschedules the date for every queued message in the thread', async () => {
    const root = createStoredPost({ state: State.QUEUE });
    const comment = createStoredPost({ id: 'stored-comment', parentPostId: root.id, state: State.QUEUE });
    const { repository, post } = createTransactionFixture([root, comment]);
    const date = '2030-12-01T12:00:00Z';
    await repository.changeDate('organization', root.id, date, false, 'schedule');
    expect(post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [root.id, comment.id] } }),
      data: { publishDate: new Date(date), state: State.QUEUE, saveAction: 'schedule', releaseId: null, releaseURL: null },
    }));
  });

  it('preserves the explicit date republish opt-in for a published thread', async () => {
    const root = createStoredPost({ state: State.PUBLISHED, releaseId: 'platform-root' });
    const comment = createStoredPost({ id: 'stored-comment', parentPostId: root.id, state: State.PUBLISHED, releaseId: 'platform-comment' });
    const { repository, post } = createTransactionFixture([root, comment]);
    const date = '2030-12-01T12:00:00Z';
    await repository.changeDate('organization', root.id, date, false, 'schedule', true);
    expect(post.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [root.id, comment.id] }, organizationId: 'organization',
        integrationId: root.integrationId, group: root.group, deletedAt: null,
      },
      data: { publishDate: new Date(date), state: State.QUEUE, saveAction: 'schedule', releaseId: null, releaseURL: null },
    });
  });

  it('never turns a published comment into a draft when changing the root status', async () => {
    const root = createStoredPost();
    const comment = createStoredPost({ id: 'published-comment', parentPostId: root.id, state: State.PUBLISHED });
    const { repository, post } = createTransactionFixture([root, comment]);
    await repository.changePostStatus('organization', root.id, 'draft');
    expect(post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: [root.id] },
        OR: [
          { id: root.id },
          { state: { not: State.PUBLISHED }, releaseId: null, releaseURL: null },
        ],
      }),
      data: { state: State.DRAFT, saveAction: 'draft' },
    }));
  });

  it.each(['draft', 'schedule'] as const)('accepts root status %s without clearing existing release results', async (status) => {
    const root = createStoredPost({ state: State.PUBLISHED, releaseId: 'platform-root', releaseURL: 'https://example.com/published' });
    const { repository, post } = createTransactionFixture([root]);
    post.findUniqueOrThrow.mockResolvedValue(root);
    await expect(repository.changePostStatus('organization', root.id, status)).resolves.toEqual(root);
    expect(post.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [root.id] } }),
      data: { state: status === 'draft' ? State.DRAFT : State.QUEUE, saveAction: status },
    }));
    const updateData = post.updateMany.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('releaseId');
    expect(updateData).not.toHaveProperty('releaseURL');
  });

  it('records a periodic or comment failure even when the root was already published', async () => {
    const root = createStoredPost({ state: State.PUBLISHED });
    const { repository, post } = createTransactionFixture([root]);
    await repository.changeState(root.id, State.ERROR, 'Comment failed', [root]);
    expect(post.updateMany).toHaveBeenCalledWith({
      where: {
        id: root.id,
        OR: [{ saveAction: null }, { saveAction: { not: 'pass' } }, { state: { not: State.DRAFT } }],
      },
      data: { state: State.ERROR, error: 'Comment failed' },
    });
    expect(post.findUniqueOrThrow).toHaveBeenCalled();
  });

  it('rejects a foreign root before changing its thread', async () => {
    const { repository, post } = createTransactionFixture();
    await expect(repository.changePostStatus('organization', 'foreign-root', 'schedule')).rejects.toBeInstanceOf(BadRequestException);
    expect(post.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-root', organizationId: 'organization', deletedAt: null, parentPostId: null },
    });
    expect(post.updateMany).not.toHaveBeenCalled();
  });
});
