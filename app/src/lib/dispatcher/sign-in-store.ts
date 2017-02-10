import { Emitter, Disposable } from 'event-kit'
import { User } from '../../models/user'
import { assertNever, fatalError } from '../fatal-error'
import { askUserToOAuth } from '../../lib/oauth'
import { validateURL, InvalidURLErrorName, InvalidProtocolErrorName } from '../../ui/lib/enterprise-validate-url'

import {
  createAuthorization,
  AuthorizationResponse,
  fetchUser,
  AuthorizationResponseKind,
  getDotComAPIEndpoint,
  getEnterpriseAPIURL,
  fetchMetadata,
} from '../../lib/api'

export enum Step {
  EndpointEntry,
  Authentication,
  TwoFactorAuthentication,
}

/** The authentication methods server allows. */
export enum AuthenticationMethods {
  /** Basic auth in order to create authorization tokens. */
  BasicAuth,

  /** OAuth web flow. */
  OAuth,
}

/** The default set of authentication methods. */
export const DefaultAuthMethods = new Set([
  AuthenticationMethods.BasicAuth,
  AuthenticationMethods.OAuth,
])

export type SignInStep = IEndpointEntryStep | IAuthenticationStep | ITwoFactorAuthenticationStep

export interface ISignInStep {
  readonly kind: Step
  readonly error?: Error,
  readonly loading?: boolean,
}

export interface IEndpointEntryStep extends ISignInStep {
  readonly kind: Step.EndpointEntry
}

export interface IAuthenticationStep extends ISignInStep {
  readonly kind: Step.Authentication
  readonly endpoint: string,
  readonly authMethods: Set<AuthenticationMethods>
}

export interface ITwoFactorAuthenticationStep extends ISignInStep {
  readonly kind: Step.TwoFactorAuthentication
  readonly endpoint: string,
  readonly username: string,
  readonly password: string
}

export class SignInStore {
  private readonly emitter = new Emitter()
  private state: SignInStep | null = null

  public SignInStore() {

  }

  private emitUpdate() {
    this.emitter.emit('did-update', this.getState())
  }

  private emitAuthenticate(user: User) {
    this.emitter.emit('did-authenticate', user)
  }

  private emitError(error: Error) {
    this.emitter.emit('did-error', error)
  }

  /** Register a function to be called when the store updates. */
  public onDidUpdate(fn: () => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  /**
   * Register a function to be called when the store successfully
   * authenticates a user.
   */
  public onDidAuthenticate(fn: () => void): Disposable {
    return this.emitter.on('did-authenticate', fn)
  }

  /** Register a function to be called when an error occurs. */
  public onDidError(fn: (error: Error) => void): Disposable {
    return this.emitter.on('did-error', fn)
  }

  public getState(): SignInStep | null {
    return this.state
  }

  private setState(state: SignInStep | null) {
    this.state = state
    this.emitUpdate()
  }

  private async fetchAllowedAuthenticationMethods(endpoint: string): Promise<Set<AuthenticationMethods>> {
    const response = await fetchMetadata(endpoint)

    if (response) {
      const authMethods = new Set([
        AuthenticationMethods.BasicAuth,
        AuthenticationMethods.OAuth,
      ])

      if (response.verifiable_password_authentication === false) {
        authMethods.delete(AuthenticationMethods.BasicAuth)
      }

      return authMethods
    } else {
      throw new Error('Unsupported Enterprise server')
    }
  }

  public reset() {
    this.setState(null)
  }

  public beginDotComSignIn() {
    this.setState({
      kind: Step.Authentication,
      endpoint: getDotComAPIEndpoint(),
      authMethods: DefaultAuthMethods,
    })
  }

  public async authenticateWithBasicAuth(username: string, password: string): Promise<void> {
    const currentState = this.state

    if (!currentState || currentState.kind !== Step.Authentication) {
      const stepText = currentState ? currentState.kind : 'null'
      return fatalError(`Sign in step '${stepText}' not compatible with authentication`)
    }

    const endpoint = currentState.endpoint

    this.setState({ ...currentState, loading: true })

    let response: AuthorizationResponse
    try {
      response = await createAuthorization(endpoint, username, password, null)
    } catch (e) {
      this.emitError(e)
      return
    }

    if (response.kind === AuthorizationResponseKind.Authorized) {
      const token = response.token
      const user = await fetchUser(endpoint, token)
      this.emitAuthenticate(user)
      this.setState(null)
    } else if (response.kind === AuthorizationResponseKind.TwoFactorAuthenticationRequired) {
      this.setState({ kind: Step.TwoFactorAuthentication, endpoint, username, password })
    } else {
      if (response.kind === AuthorizationResponseKind.Error) {
        if (response.response.error) {
          this.emitError(response.response.error)
        } else {
          this.emitError(new Error(`The server responded with an error (${response.response.statusCode})\n\n${response.response.body}`))
        }
        this.setState({ ...currentState, loading: false })
      } else if (response.kind === AuthorizationResponseKind.Failed) {
        this.setState({
          ...currentState,
          loading: false,
          error: new Error('Incorrect username or password.'),
        })
      } else {
        return assertNever(response, `Unsupported response: ${response}`)
      }
    }
  }

  public async authenticateWithBrowser(): Promise<void> {
    const currentState = this.state

    if (!currentState || currentState.kind !== Step.Authentication) {
      const stepText = currentState ? currentState.kind : 'null'
      return fatalError(`Sign in step '${stepText}' not compatible with browser authentication`)
    }

    const user = await askUserToOAuth(currentState.endpoint)

    this.emitAuthenticate(user)
    this.setState(null)
  }

  public beginEnterpriseSignIn() {
    this.setState({ kind: Step.EndpointEntry })
  }

  public async setEndpoint(url: string): Promise<void> {
    const currentState = this.state
    this.setState({ ...currentState, loading: true })

    let validUrl: string
    try {
      validUrl = validateURL(url)
    } catch (e) {
      let error = e
      if (e.name === InvalidURLErrorName) {
        error = new Error(`The Enterprise server address doesn't appear to be a valid URL. We're expecting something like https://github.example.com.`)
      } else if (e.name === InvalidProtocolErrorName) {
        error = new Error('Unsupported protocol. We can only sign in to GitHub Enterprise instances over http or https.')
      }

      this.setState({ ...currentState, loading: false, error })
      return
    }

    const endpoint = getEnterpriseAPIURL(validUrl)
    try {
      const authMethods = await this.fetchAllowedAuthenticationMethods(endpoint)
      this.setState({ kind: Step.Authentication, endpoint, authMethods })
    } catch (e) {
      let error = e
      // We'll get an ENOTFOUND if the address couldn't be resolved.
      if (e.code === 'ENOTFOUND') {
        error = new Error('The server could not be found')
      }

      this.setState({ ...currentState, loading: false, error })
    }
  }
}
