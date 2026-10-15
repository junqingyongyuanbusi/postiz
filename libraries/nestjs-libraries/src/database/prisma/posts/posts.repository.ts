import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Post as PostBody } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import {
  APPROVED_SUBMIT_FOR_ORDER,
  CreationMethod,
  Post,
  PostSaveAction,
  Prisma,
  State,
} from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.list.dto';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import utc from 'dayjs/plugin/utc';
import { v4 as uuidv4 } from 'uuid';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';

dayjs.extend(isoWeek);
dayjs.extend(weekOfYear);
dayjs.extend(isSameOrAfter);
dayjs.extend(utc);

@Injectable()
export class PostsRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _popularPosts: PrismaRepository<'popularPosts'>,
    private _comments: PrismaRepository<'comments'>,
    private _tags: PrismaRepository<'tags'>,
    private _tagsPosts: PrismaRepository<'tagsPosts'>,
    private _errors: PrismaRepository<'errors'>,
    private _transaction: PrismaTransaction
  ) {}

  searchForMissingThreeHoursPosts() {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
          deletedAt: null,
        },
        publishDate: {
          gte: dayjs.utc().subtract(2, 'day').toDate(),
          lt: dayjs.utc().toDate(),
        },
        state: 'QUEUE',
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        organizationId: true,
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
        publishDate: true,
      },
    });
  }

  getOldPosts(orgId: string, date: string) {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
        },
        organizationId: orgId,
        publishDate: {
          lte: dayjs(date).toDate(),
        },
        deletedAt: null,
        parentPostId: null,
      },
      orderBy: {
        publishDate: 'desc',
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  updateImages(id: string, images: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        image: images,
      },
    });
  }

  getPostUrls(orgId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        id: {
          in: ids,
        },
      },
      select: {
        id: true,
        releaseURL: true,
      },
    });
  }

  // Post.error persists the raw serialized workflow failure; only curated
  // provider messages are surfaced to the calendar and the public API —
  // bad_body failures whose message came from a provider handleErrors
  // mapping or a hand-written provider throw (unmapped API responses carry
  // the 'Unknown Error' placeholder instead). Internal debug strings (e.g.
  // 'Refresh channel needed') and unmapped failures come out as null.
  private curatedError(error?: string | null): string | null {
    if (!error) {
      return null;
    }
    try {
      const parsed = JSON.parse(error);
      const [type, message] = parsed?.cause?.failure?.message
        ? [parsed?.cause?.type, parsed?.cause?.failure?.message]
        : [
            parsed?.failure?.cause?.applicationFailureInfo?.type,
            parsed?.failure?.cause?.message,
          ];
      return type === 'bad_body' && message && message !== 'Unknown Error'
        ? message
        : null;
    } catch (err) {
      return null;
    }
  }

  async getPosts(orgId: string, query: GetPostsDto) {
    // Use the provided start and end dates directly
    const startDate = dayjs.utc(query.startDate).toDate();
    const endDate = dayjs.utc(query.endDate).toDate();

    const list = await this._post.model.post.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                organizationId: orgId,
              },
            ],
          },
          {
            OR: [
              {
                publishDate: {
                  gte: startDate,
                  lte: endDate,
                },
              },
              {
                intervalInDays: {
                  not: null,
                },
              },
            ],
          },
        ],
        integration: {
          deletedAt: null,
          organizationId: orgId,
          ...(query.customer ? { customerId: query.customer } : {}),
        },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        releaseId: true,
        state: true,
        error: true,
        saveAction: true,
        intervalInDays: true,
        group: true,
        creationMethod: true,
        settings: true,
        tags: {
          where: {
            tag: {
              deletedAt: null,
            },
          },
          select: {
            tag: true,
          },
        },
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
            picture: true,
          },
        },
      },
    });

    return list
      .map((post) => ({ ...post, error: this.curatedError(post.error) }))
      .reduce((all, post) => {
      if (!post.intervalInDays) {
        return [...all, post];
      }

      const addMorePosts = [];
      let startingDate = dayjs.utc(post.publishDate);
      while (dayjs.utc(endDate).isSameOrAfter(startingDate)) {
        if (dayjs(startingDate).isSameOrAfter(dayjs.utc(post.publishDate))) {
          addMorePosts.push({
            ...post,
            publishDate: startingDate.toDate(),
            actualDate: post.publishDate,
          });
        }

        startingDate = startingDate.add(post.intervalInDays, 'days');
      }

      return [...all, ...addMorePosts];
    }, [] as any[]);
  }

  async getPostsList(orgId: string, query: GetPostsListDto) {
    const page = query.page || 0;
    const limit = query.limit || 20;
    const skip = page * limit;

    const stateFilter = query.state || 'all';
    // Only scheduled posts are date-bound — a past date there means the post is
    // due. In every other state publishDate is a marker rather than a deadline,
    // so a `publishDate >= now` floor would hide rows the moment it passes.
    const stateAndDate =
      stateFilter === 'scheduled'
        ? {
            state: State.QUEUE,
            publishDate: { gte: dayjs.utc().toDate() },
          }
        : stateFilter === 'draft'
        ? { state: State.DRAFT }
        : stateFilter === 'published'
        ? { state: State.PUBLISHED }
        : {
            state: {
              in: [State.QUEUE, State.DRAFT, State.PUBLISHED, State.ERROR],
            },
          };

    const orderDirection: 'asc' | 'desc' =
      stateFilter === 'published' ? 'desc' : 'asc';

    const where = {
      AND: [
        {
          OR: [
            {
              organizationId: orgId,
            },
          ],
        },
      ],
      ...stateAndDate,
      deletedAt: null as Date | null,
      parentPostId: null as string | null,
      intervalInDays: null as number | null,

      integration: {
        deletedAt: null as any,
        organizationId: orgId,
        ...(query.customer
          ? {
              customerId: query.customer,
            }
          : {}),
        ...(query.integrations
          ? {
              id: { in: query.integrations },
            }
          : {}),
      },
    };

    const [posts, total] = await Promise.all([
      this._post.model.post.findMany({
        where,
        skip,
        take: limit,
        orderBy: {
          publishDate: orderDirection,
        },
        select: {
          id: true,
          content: true,
          publishDate: true,
          releaseURL: true,
          releaseId: true,
          state: true,
          saveAction: true,
          intervalInDays: true,
          group: true,
          creationMethod: true,
          tags: {
            where: {
              tag: {
                deletedAt: null,
              },
            },
            select: {
              tag: true,
            },
          },
          integration: {
            select: {
              id: true,
              providerIdentifier: true,
              name: true,
              picture: true,
            },
          },
        },
      }),
      this._post.model.post.count({ where }),
    ]);

    return {
      posts,
      total,
      page,
      limit,
      hasMore: skip + posts.length < total,
    };
  }

  async deletePost(orgId: string, group: string) {
    await this._post.model.post.updateMany({
      where: {
        organizationId: orgId,
        group,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    return this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        group,
        parentPostId: null,
      },
      select: {
        id: true,
      },
    });
  }

  getPostsByGroup(orgId: string, group: string) {
    return this._post.model.post.findMany({
      where: {
        group,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
      },
      include: {
        integration: true,
        tags: {
          where: {
            tag: {
              deletedAt: null,
            },
          },
          select: {
            tag: true,
          },
        },
      },
    });
  }

  // the posts of the other channels in the batch, without the given group
  getPostsByBatch(orgId: string, batchId: string, exceptGroup: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        batchId,
        group: {
          not: exceptGroup,
        },
        deletedAt: null,
        integration: {
          deletedAt: null,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  getPost(
    id: string,
    includeIntegration = false,
    orgId?: string,
    isFirst?: boolean
  ) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
      },
      include: {
        ...(includeIntegration
          ? {
              integration: true,
              tags: {
                where: {
                  tag: {
                    deletedAt: null,
                  },
                },
                select: {
                  tag: true,
                },
              },
            }
          : {}),
        childrenPost: true,
      },
    });
  }

  updatePost(id: string, postId: string, releaseURL: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state: 'PUBLISHED',
        releaseURL,
        releaseId: postId,
      },
    });
  }

  updateReleaseId(
    id: string,
    orgId: string,
    releaseId: string,
    releaseURL?: string
  ) {
    return this._post.model.post.update({
      where: {
        id,
        organizationId: orgId,
        releaseId: 'missing',
      },
      data: {
        releaseId: String(releaseId),
        ...(releaseURL ? { releaseURL } : {}),
      },
    });
  }

  updateResolvedRelease(
    id: string,
    orgId: string,
    releaseId: string,
    releaseURL: string
  ) {
    return this._post.model.post.update({
      where: {
        id,
        organizationId: orgId,
      },
      data: {
        releaseId,
        releaseURL,
      },
    });
  }

  async changeState(id: string, state: State, err?: any, body?: any) {
    if (state === 'ERROR') {
      const result = await this._post.model.post.updateMany({
        where: {
          id,
          OR: [
            { saveAction: null },
            { saveAction: { not: PostSaveAction.pass } },
            { state: { not: State.DRAFT } },
          ],
        },
        data: {
          state,
          ...(err ? { error: typeof err === 'string' ? err : JSON.stringify(err) } : {}),
        },
      });
      if (!result.count) {
        return this._post.model.post.findUniqueOrThrow({
          where: { id },
          include: { integration: { select: { providerIdentifier: true } } },
        });
      }
    }
    const include = { integration: { select: { providerIdentifier: true } } } as const;
    const update = state !== 'ERROR' ? await this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state,
        ...(err
          ? { error: typeof err === 'string' ? err : JSON.stringify(err) }
          : {}),
      },
      include,
    }) : await this._post.model.post.findUniqueOrThrow({ where: { id }, include });

    if (state === 'ERROR' && err && body) {
      try {
        await this._errors.model.errors.create({
          data: {
            message: typeof err === 'string' ? err : JSON.stringify(err),
            organizationId: update.organizationId,
            platform: update.integration.providerIdentifier,
            postId: update.id,
            body: typeof body === 'string' ? body : JSON.stringify(body),
          },
        });
      } catch (err) {}
    }

    return update;
  }

  getErrorsByPostIds(postIds: string[]) {
    return this._errors.model.errors.findMany({
      where: {
        postId: { in: postIds },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  changePostStatus(orgId: string, id: string, status: 'draft' | 'schedule') {
    return this.updatePostChain(orgId, id, status);
  }

  async changeDate(
    orgId: string,
    id: string,
    date: string,
    _isDraft: boolean,
    action: 'schedule' | 'update' = 'schedule',
    republish = false
  ) {
    // Read the draft state inside the transaction rather than trusting isDraft.
    return this.updatePostChain(orgId, id, action, date, republish);
  }

  private updatePostChain(
    orgId: string,
    id: string,
    action: 'draft' | 'schedule' | 'update',
    date?: string,
    republish = false
  ) {
    return this._transaction.model.$transaction(async (transaction) => {
      const root = await transaction.post.findFirst({
        where: { id, organizationId: orgId, deletedAt: null, parentPostId: null },
      });
      if (!root) {
        throw new BadRequestException('Post root not found');
      }
      const [posts] = await this.validatePostTargets(orgId, [{
        integration: { id: root.integrationId },
        group: root.group,
        value: [],
      } as PostBody], transaction);
      const changesState = action !== 'update';
      const resetsRelease = date !== undefined && changesState;
      const staysDraft = action === 'draft' || (date !== undefined && root.state === State.DRAFT);
      const protectPublished = resetsRelease && (staysDraft || !republish);
      if (protectPublished && posts.some((post) => post.state === State.PUBLISHED || post.releaseId || post.releaseURL)) {
        throw new ConflictException('Published post results cannot be reset through a status or scheduling change');
      }
      const data = {
        saveAction: action === 'update' ? PostSaveAction.update : staysDraft ? PostSaveAction.draft : PostSaveAction.schedule,
        ...(date !== undefined ? { publishDate: dayjs(date).toDate() } : {}),
        ...(changesState ? { state: staysDraft ? State.DRAFT : State.QUEUE } : {}),
        ...(resetsRelease ? {
          releaseId: null,
          releaseURL: null,
        } : {}),
      };
      // Status changes historically accepted the root regardless of its release
      // results. Synchronize unpublished children without rewriting published ones.
      const targets = date === undefined
        ? posts.filter((post) => post.id === root.id || (post.state !== State.PUBLISHED && !post.releaseId && !post.releaseURL))
        : posts;
      const result = await transaction.post.updateMany({
        where: {
          id: { in: targets.map((post) => post.id) },
          organizationId: orgId,
          integrationId: root.integrationId,
          group: root.group,
          deletedAt: null,
          ...(date === undefined ? {
            OR: [
              { id: root.id },
              { state: { not: State.PUBLISHED }, releaseId: null, releaseURL: null },
            ],
          } : {}),
          ...(protectPublished ? { state: { not: State.PUBLISHED }, releaseId: null, releaseURL: null } : {}),
        },
        data,
      });
      if (result.count !== targets.length) {
        throw new ConflictException('The post changed while its thread was being updated');
      }
      return transaction.post.findUniqueOrThrow({ where: { id, organizationId: orgId } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  countPostsFromDay(orgId: string, date: Date) {
    return this._post.model.post.count({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: date,
        },
        OR: [
          {
            deletedAt: null,
            state: {
              in: ['QUEUE'],
            },
          },
          {
            state: 'PUBLISHED',
          },
        ],
      },
    });
  }

  async getDraftWorkflowPostIds(orgId: string, targets: Post[]) {
    const batchIds = targets.map((post) => post.batchId).filter((batchId): batchId is string => !!batchId);
    const posts = await this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        integrationId: { in: targets.map((post) => post.integrationId) },
        OR: [
          { id: { in: targets.map((post) => post.id) } },
          { group: { in: targets.map((post) => post.group) } },
          ...(batchIds.length ? [{ batchId: { in: batchIds } }] : []),
        ],
      },
      select: { id: true },
    });
    return posts.map((post) => post.id);
  }

  async validatePostTargets(
    orgId: string,
    bodies: PostBody[],
    database: Pick<Prisma.TransactionClient, 'post'> = this._post.model
  ): Promise<Post[][]> {
    const targets = await Promise.all(bodies.map(async (body) => {
      const identifiers = body.value.map((value) => value.id).filter(Boolean);
      if (!body.group && !identifiers.length) {
        return [];
      }
      const matchedPosts = await database.post.findMany({
        where: {
          OR: [
            ...(body.group ? [{ group: body.group, deletedAt: null }] : []),
            ...(identifiers.length ? [{ id: { in: identifiers } }] : []),
          ],
        },
      });
      const identifiedPosts = matchedPosts.filter((post) => identifiers.includes(post.id));
      if (
        matchedPosts.some((post) => post.organizationId !== orgId || post.deletedAt) ||
        identifiedPosts.some((post) => post.integrationId !== body.integration.id)
      ) {
        throw new BadRequestException('Post id or group is not owned by this integration');
      }
      // Editors assign temporary ids and a shared group to entirely new posts.
      // A supplied id that exists anywhere, however, must pass ownership checks.
      if (!matchedPosts.length) {
        return [];
      }
      // Adding a channel to existing content reuses the editor's shared group.
      // With no persisted ids on this channel it is a placeholder, never an
      // instruction to modify the other channel's rows.
      if (!identifiedPosts.length && matchedPosts.every((post) => post.integrationId !== body.integration.id)) {
        return [];
      }
      const persistedIdentifiers = identifiers.filter((identifier) => matchedPosts.some((post) => post.id === identifier));
      if (new Set(persistedIdentifiers).size !== persistedIdentifiers.length) {
        throw new BadRequestException('An existing post cannot be saved more than once');
      }
      const targetGroup = identifiedPosts[0]?.group || body.group;
      if ((body.group && targetGroup !== body.group) || identifiedPosts.some((post) => post.group !== targetGroup)) {
        throw new BadRequestException('All post ids must belong to the same root');
      }
      const groupPosts = await database.post.findMany({
        where: { organizationId: orgId, group: targetGroup, deletedAt: null },
      });
      const root = groupPosts.find((post) => !post.parentPostId);
      if (!root) {
        throw new BadRequestException('Post root or group not found');
      }
      if (groupPosts.some((post) => post.integrationId !== body.integration.id) || groupPosts.filter((post) => !post.parentPostId).length !== 1) {
        throw new BadRequestException('Post group does not belong to this integration');
      }
      for (const post of groupPosts) {
        const visited = new Set<string>();
        let ancestor = post;
        while (ancestor.parentPostId) {
          if (visited.has(ancestor.id)) {
            throw new BadRequestException('Invalid post comment chain');
          }
          visited.add(ancestor.id);
          const parent = groupPosts.find((candidate) => candidate.id === ancestor.parentPostId);
          if (!parent) {
            throw new BadRequestException('Post comment does not belong to this root');
          }
          ancestor = parent;
        }
        if (ancestor.id !== root.id) {
          throw new BadRequestException('Post comment does not belong to this root');
        }
      }
      return groupPosts;
    }));
    const persistedIds = targets.flat().map((post) => post.id);
    if (new Set(persistedIds).size !== persistedIds.length) {
      throw new BadRequestException('An existing group cannot be saved more than once');
    }
    return targets;
  }

  async createOrUpdatePost(
    state: 'draft' | 'schedule' | 'now' | 'update',
    orgId: string,
    date: string,
    body: PostBody,
    tags: { value: string; label: string }[],
    creationMethod: CreationMethod,
    inter?: number,
    // Keep the existing group instead of rotating it, so open clients
    // (calendar) holding the group stay valid. Used by out-of-band updates
    // (agent / MCP / public API); the dashboard keeps the rotate-and-sweep.
    keepGroup = false,
    // Shared by the posts saved together for several channels, so opening one
    // of them in the editor brings the others.
    batchId?: string,
    saveAction: PostSaveAction = state,
    republish = false
  ) {
    try {
      return await this._transaction.model.$transaction(async (transaction) => {
        const integration = await transaction.integration.findFirst({
          where: { id: body.integration.id, organizationId: orgId, deletedAt: null },
          select: { id: true },
        });
        if (!integration) {
          throw new BadRequestException('Integration not found');
        }
        const [existingPosts] = await this.validatePostTargets(orgId, [body], transaction);
        const existingRoot = existingPosts.find((post) => !post.parentPostId);
        const protectPublished = saveAction === 'pass' || ((state === 'schedule' || state === 'now') && !republish);
        if (protectPublished && existingPosts.some((post) => post.state === 'PUBLISHED')) {
          throw new ConflictException('This post was published while it was being saved');
        }
        if (saveAction === 'pass' && existingPosts.some((post) => post.state !== 'DRAFT' || post.releaseId || post.releaseURL || post.error)) {
          throw new ConflictException('Only untouched drafts can be passed safely');
        }
        if (state === 'update' && !existingRoot) {
          throw new BadRequestException('An update requires an existing post');
        }

        const posts: Post[] = [];
        const group = keepGroup && body.group ? body.group : uuidv4();
        const existingBatchId = existingPosts.find((post) => post.batchId)?.batchId;
        for (const value of body.value) {
          const previousComment = posts[posts.length - 1];
          const existingPost = existingPosts.find((post) => post.id === value.id);
          const data = {
            publishDate: dayjs(date).toDate(),
            integration: { connect: { id: integration.id, organizationId: orgId } },
            ...(previousComment
              ? { parentPost: { connect: { id: previousComment.id } } }
              : {}),
            content: value.content,
            delay: value.delay || 0,
            group,
            batchId: existingBatchId || batchId,
            intervalInDays: inter ? +inter : null,
            approvedSubmitForOrder: APPROVED_SUBMIT_FOR_ORDER.NO,
            saveAction,
            // New comments inherit the root state on a content-only update.
            ...(state === 'update'
              ? existingPost ? {} : { state: existingRoot!.state }
              : { state: state === 'draft' ? State.DRAFT : State.QUEUE }),
            image: JSON.stringify(value.image),
            settings: JSON.stringify(body.settings),
            organization: { connect: { id: orgId } },
          };
          posts.push(existingPost
            ? await transaction.post.update({
                where: {
                  id: value.id,
                  organizationId: orgId,
                  integrationId: integration.id,
                  deletedAt: null,
                  ...(saveAction === 'pass'
                    ? { state: State.DRAFT, releaseId: null, releaseURL: null, error: null }
                    : protectPublished ? { state: { not: State.PUBLISHED } } : {}),
                },
                data: {
                  ...data,
                  ...(!previousComment ? { parentPost: { disconnect: true } } : {}),
                  lastMessage: { disconnect: true },
                  submittedForOrder: { disconnect: true },
                },
              })
            : await transaction.post.create({ data: { ...data, id: uuidv4(), creationMethod } }));
        }

        await transaction.tagsPosts.deleteMany({ where: { postId: posts[0].id } });
        const tagsList = tags.length ? await transaction.tags.findMany({
          where: {
            orgId,
            deletedAt: null,
            name: { in: tags.map((tag) => tag.label).filter(Boolean) },
          },
          select: { id: true },
        }) : [];
        if (tagsList.length) {
          await transaction.post.update({
            where: { id: posts[0].id, organizationId: orgId },
            data: { tags: { createMany: { data: tagsList.map((tag) => ({ tagId: tag.id })) } } },
          });
        }

        if (body.group) {
          const removedPosts = existingPosts.filter((post) => !posts.some((savedPost) => savedPost.id === post.id));
          const removed = await transaction.post.updateMany({
            where: {
              id: { in: removedPosts.map((post) => post.id) },
              organizationId: orgId,
              integrationId: integration.id,
              group: body.group,
              deletedAt: null,
              ...(saveAction === 'pass'
                ? { state: State.DRAFT, releaseId: null, releaseURL: null, error: null }
                : protectPublished ? { state: { not: State.PUBLISHED } } : {}),
            },
            data: { parentPostId: null, deletedAt: new Date() },
          });
          if (removed.count !== removedPosts.length) {
            throw new ConflictException('The post changed while it was being saved');
          }
        }
        return { previousPost: existingRoot?.id, posts };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2025', 'P2034'].includes(error.code)) {
        throw new ConflictException('The post changed while it was being saved. Reload before retrying.');
      }
      throw error;
    }
  }

  async submit(id: string, order: string, buyerOrganizationId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        submittedForOrderId: order,
        approvedSubmitForOrder: 'WAITING_CONFIRMATION',
        submittedForOrganizationId: buyerOrganizationId,
      },
      select: {
        id: true,
        description: true,
        submittedForOrder: {
          select: {
            messageGroupId: true,
          },
        },
      },
    });
  }

  updateMessage(id: string, messageId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        lastMessageId: messageId,
      },
    });
  }

  getPostById(id: string, org?: string) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(org ? { organizationId: org } : {}),
      },
      include: {
        integration: true,
        submittedForOrder: {
          include: {
            posts: {
              where: {
                state: 'PUBLISHED',
              },
            },
            ordersItems: true,
            seller: {
              select: {
                id: true,
                account: true,
              },
            },
          },
        },
      },
    });
  }

  private get postTimelineSelect() {
    return {
      id: true,
      state: true,
      publishDate: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      releaseId: true,
      releaseURL: true,
      error: true,
      creationMethod: true,
      group: true,
      parentPostId: true,
    } as const;
  }

  getPostTimeline(id: string, org: string) {
    return this._post.model.post.findFirst({
      where: {
        id,
        organizationId: org,
      },
      select: {
        ...this.postTimelineSelect,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            disabled: true,
            refreshNeeded: true,
            deletedAt: true,
          },
        },
        childrenPost: {
          select: this.postTimelineSelect,
          orderBy: { publishDate: 'asc' as const },
        },
        errors: {
          select: {
            id: true,
            platform: true,
            message: true,
            body: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' as const },
        },
      },
    });
  }

  findAllExistingCategories() {
    return this._popularPosts.model.popularPosts.findMany({
      select: {
        category: true,
      },
      distinct: ['category'],
    });
  }

  findAllExistingTopicsOfCategory(category: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
      },
      select: {
        topic: true,
      },
      distinct: ['topic'],
    });
  }

  findPopularPosts(category: string, topic?: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
        ...(topic ? { topic } : {}),
      },
      select: {
        content: true,
        hook: true,
      },
    });
  }

  createPopularPosts(post: {
    category: string;
    topic: string;
    content: string;
    hook: string;
  }) {
    return this._popularPosts.model.popularPosts.create({
      data: {
        category: 'category',
        topic: 'topic',
        content: 'content',
        hook: 'hook',
      },
    });
  }

  async getPostsCountsByDates(
    orgId: string,
    times: number[],
    date: dayjs.Dayjs
  ) {
    const dates = await this._post.model.post.findMany({
      where: {
        deletedAt: null,
        organizationId: orgId,
        publishDate: {
          in: times.map((time) => {
            return date.clone().add(time, 'minutes').toDate();
          }),
        },
      },
    });

    return times.filter(
      (time) =>
        date.clone().add(time, 'minutes').isAfter(dayjs.utc()) &&
        !dates.find((dateFind) => {
          return (
            dayjs
              .utc(dateFind.publishDate)
              .diff(date.clone().startOf('day'), 'minutes') == time
          );
        })
    );
  }

  getCommentsForPosts(postIds: string[]) {
    return this._comments.model.comments.findMany({
      where: {
        postId: {
          in: postIds,
        },
        deletedAt: null,
      },
      include: {
        user: {
          select: {
            name: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  getCommentById(id: string) {
    return this._comments.model.comments.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        post: {
          select: {
            id: true,
            organizationId: true,
          },
        },
      },
    });
  }

  setCommentResolved(id: string, resolvedAt: Date | null) {
    return this._comments.model.comments.update({
      where: {
        id,
      },
      data: {
        resolvedAt,
      },
    });
  }

  getAnchoredCommentsForPost(postId: string) {
    return this._comments.model.comments.findMany({
      where: {
        postId,
        deletedAt: null,
        anchorStart: {
          not: null,
        },
      },
    });
  }

  detachAnchorsForPost(postId: string, ids: string[]) {
    return this._comments.model.comments.updateMany({
      where: {
        postId,
        id: {
          in: ids,
        },
      },
      data: {
        anchorStart: null,
        anchorEnd: null,
      },
    });
  }

  async getTags(orgId: string) {
    return this._tags.model.tags.findMany({
      where: {
        orgId,
        deletedAt: null,
      },
    });
  }

  createTag(orgId: string, body: CreateTagDto) {
    return this._tags.model.tags.create({
      data: {
        orgId,
        name: body.name,
        color: body.color,
      },
    });
  }

  editTag(id: string, orgId: string, body: CreateTagDto) {
    return this._tags.model.tags.update({
      where: {
        id,
      },
      data: {
        name: body.name,
        color: body.color,
      },
    });
  }

  async deleteTag(id: string, orgId: string) {
    const tag = await this._tags.model.tags.update({
      where: {
        id,
        orgId,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    await this._tagsPosts.model.tagsPosts.deleteMany({
      where: {
        tagId: tag.id,
      },
    });

    return tag;
  }

  createComment(
    orgId: string,
    userId: string | null,
    postId: string,
    content: string,
    extra: {
      displayName?: string;
      parentId?: string;
      anchorStart?: number;
      anchorEnd?: number;
      anchorQuote?: string;
    } = {}
  ) {
    return this._comments.model.comments.create({
      data: {
        organizationId: orgId,
        userId,
        postId,
        content,
        displayName: extra.displayName ?? null,
        parentId: extra.parentId ?? null,
        anchorStart: extra.anchorStart ?? null,
        anchorEnd: extra.anchorEnd ?? null,
        anchorQuote: extra.anchorQuote ?? null,
      },
    });
  }

  async getPostByForWebhookId(postId: string, integrationId: string) {
    const select = {
      id: true,
      content: true,
      publishDate: true,
      releaseURL: true,
      state: true,
      integration: {
        select: {
          id: true,
          name: true,
          providerIdentifier: true,
          picture: true,
          type: true,
        },
      },
    };

    const posts = await this._post.model.post.findMany({
      where: {
        id: postId,
        deletedAt: null,
        parentPostId: null,
      },
      select,
    });

    if (posts.length) {
      return posts;
    }

    // The running workflows pass the platform's post id, which updatePost
    // already stored on the row as releaseId before the webhook is sent.
    return this._post.model.post.findMany({
      where: {
        releaseId: postId,
        integrationId,
        deletedAt: null,
        parentPostId: null,
      },
      orderBy: {
        updatedAt: 'desc' as const,
      },
      take: 1,
      select,
    });
  }

  async getPostsSince(orgId: string, since: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: new Date(since),
        },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }
}
