declare module 'nestjs-dataloader' {
  import type {
    CallHandler,
    ExecutionContext,
    NestInterceptor,
    PipeTransform,
    Type
  } from '@nestjs/common';
  import type { ModuleRef } from '@nestjs/core';
  import type DataLoader from 'dataloader';
  import type { Observable } from 'rxjs';

  export interface NestDataLoader<ID, Value> {
    generateDataLoader(): DataLoader<ID, Value>;
  }

  export declare class DataLoaderInterceptor implements NestInterceptor {
    private readonly moduleRef: ModuleRef;
    constructor(moduleRef: ModuleRef);
    intercept(context: ExecutionContext, next: CallHandler): Observable<any>;
  }

  export declare const Loader: (
    ...dataOrPipes: (
      | Type<NestDataLoader<any, any>>
      | PipeTransform<any, any>
      | Type<PipeTransform<any, any>>
    )[]
  ) => ParameterDecorator;
}

declare module 'graphql-depth-limit' {
  import type { ValidationRule } from 'graphql';

  export default function depthLimit(
    maxDepth: number,
    options?: unknown
  ): ValidationRule;
}
