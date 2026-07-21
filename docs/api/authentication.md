# Authentication & Authorization

> **Shipped V2 authentication is Azure Entra (App Service Easy Auth) — NOT Supabase.**
> The MG-24 V2 infrastructure enforces authentication at the **platform layer**: the
> Function App's `auth_settings_v2` / `active_directory_v2` provider validates inbound
> Entra bearer tokens before any function runs (`require_authentication = true`,
> `unauthenticated_action = Return401`, no client secret). See
> [Terraform Setup → Authentication Integration](../infrastructure/terraform-setup.md#authentication-integration)
> and the [bootstrap runbook](../infrastructure/bootstrap-runbook.md) for the shipped model.
>
> The **application-layer** sections further down (Authentication Methods, the JWT
> middleware, RBAC, and the client/mobile SDK examples) describe an **earlier
> Supabase-based design that was never implemented** — there is no Supabase code in
> `apps/`/`libs/`. Treat them as an unbuilt proposal, not current behavior; they must
> be reconciled to the Entra model (or removed) by the application owner before they
> can be trusted.

## Overview

MeatGeek V2 authenticates API callers with **Azure Entra** via Azure App Service
**Easy Auth** (`auth_settings_v2`). Authentication is enforced by the platform in
front of the Azure Functions host — the application code does not implement a token
provider or a sign-in flow. There is **no Supabase** and no external auth provider in
the V2 stack.

## Authentication Architecture

### Why Azure Entra Easy Auth?

- **Fail-closed by construction**: a Terraform precondition refuses to deploy the
  Function App unless an Entra identity provider is configured, so an anonymous API
  can never ship.
- **Platform-enforced**: every request is validated (`Return401` on a missing/invalid
  token) before any function runs, independent of a function's own `authLevel`.
- **No long-lived secret**: Easy Auth only *validates* bearer tokens — no client
  secret is set and no token is stored at rest (`token_store_enabled = false`).
- **First-class Azure integration**: the identity provider is wired through the same
  Terraform apply as the rest of the V2 stack; the dev Entra API registration is
  created by the bootstrap.

### Integration Strategy

```
┌─────────────────┐    ┌──────────────────┐    ┌──────────────────────────┐
│   Mobile/Web    │───▶│   Azure Entra    │───▶│   Azure Functions        │
│   Applications  │    │  (bearer tokens) │    │  (Easy Auth validates)   │
└─────────────────┘    └──────────────────┘    └──────────────────────────┘
                                                          │
                                                          ▼
                                                 ┌─────────────────┐
                                                 │   CosmosDB      │
                                                 │   (User Data)   │
                                                 └─────────────────┘
```

**Key points:**
- Clients acquire an Entra bearer token for the API's delegated `access_as_user`
  scope (`api://<api-app-id>/access_as_user`).
- Easy Auth validates the token's audience (`allowed_audiences` = the API App ID URI)
  and the calling client (`allowed_applications` = the pre-authorized client id) at
  the platform layer — the function never sees an unauthenticated request.
- CosmosDB remains the application data store; access to it is via the Function App's
  managed identity, not the caller's token.

## Authentication Methods Supported

### Primary Authentication
- **Email/Password**: Traditional username/password authentication
- **Magic Links**: Passwordless email-based authentication
- **Phone/SMS**: SMS-based OTP authentication

### Social Authentication
- **Google**: OAuth integration for Google accounts
- **Apple**: Sign in with Apple for iOS users
- **GitHub**: Developer-friendly OAuth for tech-savvy users
- **Facebook**: Social media account integration

### Multi-Factor Authentication (MFA)
- **TOTP**: Time-based one-time passwords (Google Authenticator, Authy)
- **SMS**: SMS-based second factor
- **Email**: Email-based verification codes

## JWT Token Structure

### Access Token Claims

```typescript
interface MeatGeekJWTPayload {
  // Standard JWT claims
  sub: string;          // User ID
  iss: string;          // Issuer (Supabase)
  aud: string;          // Audience
  exp: number;          // Expiration timestamp
  iat: number;          // Issued at timestamp
  
  // Custom claims
  email: string;        // User email
  email_verified: boolean;
  phone?: string;       // Optional phone number
  phone_verified?: boolean;
  
  // MeatGeek-specific claims
  app_metadata: {
    provider: string;   // Auth provider used
    providers: string[];
  };
  user_metadata: {
    full_name?: string;
    avatar_url?: string;
    device_ids?: string[];  // Associated device IDs
  };
  
  // Role-based access control
  role: 'device_owner' | 'read_only' | 'admin';
  permissions?: string[];
}
```

### Token Validation Requirements

Token validation is performed by **Easy Auth at the platform layer** (not by
application code), against the Entra identity provider:

1. **Signature Verification**: Validate the JWT signature against the Entra tenant's
   published signing keys (`tenant_auth_endpoint` = `https://login.microsoftonline.com/<tenant-id>/v2.0`)
2. **Expiration Check**: Ensure the token is not expired
3. **Audience Validation**: Verify `aud` matches the API App ID URI (`allowed_audiences`)
4. **Client Validation**: Verify the calling client's `appid`/`azp` is pre-authorized
   (`allowed_applications`); reject tokens minted by any other client

## Role-Based Access Control (RBAC)

### User Roles

#### Device Owner
- **Description**: Primary owner of one or more MeatGeek devices
- **Permissions**:
  - Create, start, stop, and manage cook sessions
  - View all temperature data for owned devices
  - Configure device settings and preferences
  - Share read-only access with other users
  - Export cook data and reports

#### Read-Only User
- **Description**: Shared access to view cook sessions and temperature data
- **Permissions**:
  - View active cook sessions for shared devices
  - Access historical cook data and temperature readings
  - Receive notifications for shared cooks
  - Cannot start/stop cooks or modify settings

#### Admin
- **Description**: System administrator with full access
- **Permissions**:
  - Manage all devices and users
  - Access system-wide analytics and reports
  - Configure global settings and policies
  - Monitor system health and performance

### Permission Implementation

```typescript
// Example permission checks in API functions
enum Permissions {
  CREATE_COOK = 'cook:create',
  VIEW_COOK = 'cook:view',
  MANAGE_DEVICE = 'device:manage',
  VIEW_DEVICE = 'device:view',
  ADMIN_ACCESS = 'admin:*'
}

// Function middleware example
async function requirePermission(permission: Permissions) {
  // JWT validation and permission checking logic
}
```

## Azure Functions JWT Middleware

### Middleware Implementation

```typescript
// libs/auth/src/lib/jwt-middleware.ts
import { Context, HttpRequest } from '@azure/functions';
import { createClient } from '@supabase/supabase-js';
import { verify } from 'jsonwebtoken';
import { MeatGeekJWTPayload } from './types';

interface AuthenticatedRequest extends HttpRequest {
  user?: MeatGeekJWTPayload;
}

export class JWTMiddleware {
  private supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );

  async validateToken(token: string): Promise<MeatGeekJWTPayload> {
    // Verify JWT signature using Supabase public key
    const { data, error } = await this.supabase.auth.getUser(token);
    
    if (error || !data.user) {
      throw new Error('Invalid or expired token');
    }

    return this.extractClaims(data.user, token);
  }

  async requireAuth(
    context: Context, 
    req: AuthenticatedRequest
  ): Promise<MeatGeekJWTPayload> {
    const authHeader = req.headers.authorization;
    
    if (!authHeader?.startsWith('Bearer ')) {
      context.res = {
        status: 401,
        body: { error: 'Missing or invalid authorization header' }
      };
      throw new Error('Unauthorized');
    }

    const token = authHeader.substring(7);
    const user = await this.validateToken(token);
    
    req.user = user;
    return user;
  }

  async requirePermission(
    user: MeatGeekJWTPayload, 
    permission: string,
    resourceId?: string
  ): Promise<void> {
    // Check role-based permissions
    if (!this.hasPermission(user, permission, resourceId)) {
      throw new Error('Insufficient permissions');
    }
  }

  private hasPermission(
    user: MeatGeekJWTPayload, 
    permission: string, 
    resourceId?: string
  ): boolean {
    // Implement permission logic based on role and resource
    switch (user.role) {
      case 'admin':
        return true;
      case 'device_owner':
        return this.checkDeviceOwnership(user, resourceId) && 
               this.isDevicePermission(permission);
      case 'read_only':
        return this.isReadOnlyPermission(permission);
      default:
        return false;
    }
  }

  private checkDeviceOwnership(user: MeatGeekJWTPayload, deviceId?: string): boolean {
    return deviceId ? 
      user.user_metadata.device_ids?.includes(deviceId) ?? false : 
      true;
  }

  private isDevicePermission(permission: string): boolean {
    const devicePermissions = [
      'cook:create', 'cook:manage', 'cook:delete',
      'device:manage', 'device:configure'
    ];
    return devicePermissions.includes(permission);
  }

  private isReadOnlyPermission(permission: string): boolean {
    const readPermissions = [
      'cook:view', 'device:view', 'temperature:view'
    ];
    return readPermissions.includes(permission);
  }

  private extractClaims(user: any, token: string): MeatGeekJWTPayload {
    // Extract and transform Supabase user to MeatGeek JWT payload
    return {
      sub: user.id,
      email: user.email,
      email_verified: user.email_confirmed_at !== null,
      phone: user.phone,
      phone_verified: user.phone_confirmed_at !== null,
      role: this.determineUserRole(user),
      app_metadata: user.app_metadata,
      user_metadata: user.user_metadata,
      iss: 'supabase',
      aud: 'meatgeek-v2',
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      iat: Math.floor(Date.now() / 1000)
    };
  }

  private determineUserRole(user: any): 'device_owner' | 'read_only' | 'admin' {
    // Role determination logic based on user metadata
    if (user.app_metadata?.role === 'admin') return 'admin';
    if (user.user_metadata?.device_ids?.length > 0) return 'device_owner';
    return 'read_only';
  }
}
```

### Function Usage Example

```typescript
// apps/api/src/functions/cooks/start-cook.ts
import { HttpTrigger } from '@azure/functions';
import { JWTMiddleware } from '@meatgeekv2/auth';
import { StartCookRequest, Cook } from '@meatgeekv2/api-interfaces';

const authMiddleware = new JWTMiddleware();

export const startCook: HttpTrigger = async (context, req) => {
  try {
    // Authenticate user
    const user = await authMiddleware.requireAuth(context, req);
    
    // Authorize action
    await authMiddleware.requirePermission(user, 'cook:create', req.body.deviceId);
    
    // Process request
    const cookRequest: StartCookRequest = req.body;
    const cook = await createCook(cookRequest, user);
    
    return {
      status: 201,
      body: cook
    };
  } catch (error) {
    return {
      status: error.message === 'Unauthorized' ? 401 : 403,
      body: { error: error.message }
    };
  }
};
```

## Client-Side Integration

### React Native/Mobile App

```typescript
// libs/auth-client/src/lib/supabase-client.ts
import { createClient, AuthSession } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

class AuthService {
  private supabase = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    }
  );

  async signIn(email: string, password: string) {
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password,
    });
    
    if (error) throw error;
    return data;
  }

  async signInWithGoogle() {
    const { data, error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
    });
    
    if (error) throw error;
    return data;
  }

  async signOut() {
    const { error } = await this.supabase.auth.signOut();
    if (error) throw error;
  }

  onAuthStateChange(callback: (session: AuthSession | null) => void) {
    return this.supabase.auth.onAuthStateChange((_event, session) => {
      callback(session);
    });
  }

  getCurrentSession() {
    return this.supabase.auth.getSession();
  }

  async getAccessToken(): Promise<string | null> {
    const { data: { session } } = await this.supabase.auth.getSession();
    return session?.access_token ?? null;
  }
}

export const authService = new AuthService();
```

### React Context for Authentication

```typescript
// apps/mobile/src/contexts/auth-context.tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import { AuthSession } from '@supabase/supabase-js';
import { authService } from '@meatgeekv2/auth-client';

interface AuthContextType {
  session: AuthSession | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Get initial session
    authService.getCurrentSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = authService.onAuthStateChange((session) => {
      setSession(session);
      setLoading(false);
    });

    return () => subscription?.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { session } = await authService.signIn(email, password);
    setSession(session);
  };

  const signOut = async () => {
    await authService.signOut();
    setSession(null);
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        signIn,
        signOut,
        isAuthenticated: !!session,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
```

## API Client with Authentication

```typescript
// libs/api-client/src/lib/http-client.ts
import { authService } from '@meatgeekv2/auth-client';

class APIClient {
  private baseURL = process.env.EXPO_PUBLIC_API_BASE_URL!;

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await authService.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const authHeaders = await this.getAuthHeaders();
    
    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...options.headers,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Token expired, redirect to login
        await authService.signOut();
        throw new Error('Authentication required');
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  // Cook management endpoints
  async startCook(cookData: StartCookRequest): Promise<Cook> {
    return this.request<Cook>('/api/cooks', {
      method: 'POST',
      body: JSON.stringify(cookData),
    });
  }

  async getCookHistory(cookId: string): Promise<TemperatureReading[]> {
    return this.request<TemperatureReading[]>(`/api/cooks/${cookId}/temperatures`);
  }
}

export const apiClient = new APIClient();
```

## Security Best Practices

### Token Security
- **Secure Storage**: Use device keychain/secure storage for tokens
- **Token Rotation**: Implement automatic refresh token rotation
- **Short Expiry**: Keep access tokens short-lived (1 hour)
- **HTTPS Only**: All authentication traffic over HTTPS

### API Security
- **Rate Limiting**: Implement per-user rate limiting
- **Input Validation**: Validate all inputs before processing
- **CORS Configuration**: Restrict CORS to known origins
- **Audit Logging**: Log all authentication events

### Device Security
- **Biometric Unlock**: Support Face ID/Touch ID/Fingerprint
- **Device Binding**: Optional device registration for enhanced security
- **Session Management**: Clear sessions on app uninstall

## Implementation Strategy

### Development Phases
1. **Phase 1**: Set up Supabase project and configure authentication providers
2. **Phase 2**: Implement JWT middleware library and Azure Functions integration
3. **Phase 3**: Build mobile and web client authentication flows
4. **Phase 4**: Add role-based permissions and device ownership management
5. **Phase 5**: Implement monitoring, logging, and security best practices

### Initial Setup Requirements
- Supabase project creation and configuration
- Authentication provider setup (Google, Apple, GitHub)
- JWT middleware library development
- Azure Functions environment configuration
- Client SDK integration for mobile and web applications

## Monitoring & Analytics

### Authentication Metrics
- **Login Success Rate**: Track successful vs failed login attempts
- **Authentication Method Usage**: Monitor which auth methods are most popular
- **Token Refresh Rate**: Monitor token refresh patterns
- **Session Duration**: Track average user session lengths

### Security Monitoring
- **Failed Login Attempts**: Alert on suspicious login patterns
- **Geographic Anomalies**: Monitor logins from unusual locations
- **Device Changes**: Track when users log in from new devices
- **Permission Escalation**: Monitor role and permission changes

### Dashboards and Alerts
- **Real-time Authentication Dashboard**: Live view of auth events
- **Security Incident Alerts**: Immediate notifications for security issues
- **Weekly Security Reports**: Regular security posture summaries
- **User Growth Analytics**: Track user registration and retention

This authentication architecture provides a modern, secure, and cost-effective solution for the MeatGeek V2 system while maintaining the flexibility to adapt to future requirements.