import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';

import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  get<T>(path: string) {
    return this.http.get<T>(`${this.baseUrl}${path}`, { withCredentials: true });
  }

  post<T>(path: string, body: unknown) {
    return this.http.post<T>(`${this.baseUrl}${path}`, body, { withCredentials: true });
  }

  put<T>(path: string, body: unknown) {
    return this.http.put<T>(`${this.baseUrl}${path}`, body, { withCredentials: true });
  }

  delete<T>(path: string) {
    return this.http.delete<T>(`${this.baseUrl}${path}`, { withCredentials: true });
  }
}
