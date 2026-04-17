import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { finalize } from 'rxjs';

import { LoadingStateService } from './loading-state.service';

function shouldSkipLoader(url: string): boolean {
  return url.includes('/api/web/supplies');
}

export const loadingInterceptor: HttpInterceptorFn = (req, next) => {
  if (shouldSkipLoader(req.url)) {
    return next(req);
  }

  const loading = inject(LoadingStateService);
  loading.start();

  return next(req).pipe(
    finalize(() => {
      loading.stop();
    }),
  );
};
