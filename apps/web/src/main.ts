import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { AppComponent } from './app/app.component';
import { appRoutes } from './app/app.routes';
import { loadingInterceptor } from './app/services/loading.interceptor';

bootstrapApplication(AppComponent, {
  providers: [provideRouter(appRoutes), provideHttpClient(withFetch(), withInterceptors([loadingInterceptor]))],
}).catch((error) => console.error(error));
