import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {useWeb3} from '@builtbymom/web3/contexts/useWeb3';
import {toAddress, toNormalizedBN} from '@builtbymom/web3/utils';
import {useActionFlow} from '@vaults/contexts/useActionFlow';
import {useSolverChainCoin} from '@vaults/hooks/useSolverChainCoin';
import {useSolverCowswap} from '@vaults/hooks/useSolverCowswap';
import {useSolverInternalMigration} from '@vaults/hooks/useSolverInternalMigration';
import {useSolverOptimismBooster} from '@vaults/hooks/useSolverOptimismBooster';
import {useSolverPartnerContract} from '@vaults/hooks/useSolverPartnerContract';
import {useSolverPortals} from '@vaults/hooks/useSolverPortals';
import {useSolverVanilla} from '@vaults/hooks/useSolverVanilla';
import {serialize} from '@wagmi/core';
import {Solver} from '@common/schemas/yDaemonTokenListBalances';
import {hash} from '@common/utils';

import type {TNormalizedBN} from '@builtbymom/web3/types';
import type {TSolver} from '@common/schemas/yDaemonTokenListBalances';
import type {TInitSolverArgs, TSolverContext, TWithSolver} from '@vaults/types/solvers';

export const isSolverDisabled = (key: TSolver): boolean => {
	const solverStatus = {
		[Solver.enum.Vanilla]: false,
		[Solver.enum.PartnerContract]: false,
		[Solver.enum.ChainCoin]: false,
		[Solver.enum.InternalMigration]: false,
		[Solver.enum.OptimismBooster]: false,
		[Solver.enum.Cowswap]: false,
		[Solver.enum.Portals]: false,
		[Solver.enum.None]: false
	};
	return solverStatus[key as typeof Solver.enum.Vanilla] || false;
};

type TUpdateSolverHandler = {
	currentNonce: number;
	request: TInitSolverArgs;
	quote: PromiseSettledResult<TNormalizedBN>;
	solver: TSolver;
	ctx: TSolverContext;
};

const DefaultWithSolverContext: TWithSolver = {
	currentSolver: Solver.enum.Vanilla,
	effectiveSolver: Solver.enum.Vanilla,
	expectedOut: toNormalizedBN(0),
	hash: undefined,
	isLoadingExpectedOut: false,
	onRetrieveAllowance: async (): Promise<TNormalizedBN> => toNormalizedBN(0),
	onApprove: async (): Promise<void> => Promise.resolve(),
	onExecuteDeposit: async (): Promise<void> => Promise.resolve(),
	onExecuteWithdraw: async (): Promise<void> => Promise.resolve()
};

const WithSolverContext = createContext<TWithSolver>(DefaultWithSolverContext);
export function WithSolverContextApp({children}: {children: React.ReactElement}): React.ReactElement {
	const {address} = useWeb3();
	const {currentVault, actionParams, currentSolver, isDepositing} = useActionFlow();
	const executionNonce = useRef<number>(0);
	const cowswap = useSolverCowswap();
	const vanilla = useSolverVanilla();
	const portals = useSolverPortals();
	const chainCoin = useSolverChainCoin();
	const partnerContract = useSolverPartnerContract();
	const internalMigration = useSolverInternalMigration();
	const optimismBooster = useSolverOptimismBooster();
	const [currentSolverState, set_currentSolverState] = useState<TSolverContext & {hash?: string}>(vanilla);
	const [isLoading, set_isLoading] = useState(false);

	const handleUpdateSolver = useCallback(
		async ({currentNonce, request, quote, solver, ctx}: TUpdateSolverHandler): Promise<void> => {
			if (quote.status !== 'fulfilled') {
				return;
			}
			if (currentNonce !== executionNonce.current) {
				return;
			}
			const requestHash = await hash(serialize({...request, solver, expectedOut: quote.value.raw}));
			set_currentSolverState({
				...ctx,
				quote: quote.value,
				hash: requestHash
			});
			set_isLoading(false);
		},
		[executionNonce]
	);

	/* 🔵 - Yearn Finance **************************************************************************
	 ** Based on the currentSolver, we initialize the solver with the required parameters.
	 **********************************************************************************************/
	const onUpdateSolver = useCallback(
		async (currentNonce: number): Promise<void> => {
			if (
				!actionParams?.selectedOptionFrom ||
				!actionParams?.selectedOptionTo ||
				actionParams?.amount.raw === undefined
			) {
				return;
			}
			if (actionParams.amount.raw === 0n) {
				return set_currentSolverState({...vanilla, quote: toNormalizedBN(0)});
			}

			set_isLoading(true);

			const request: TInitSolverArgs = {
				chainID: currentVault.chainID,
				version: currentVault.version,
				from: toAddress(address || ''),
				inputToken: actionParams.selectedOptionFrom,
				outputToken: actionParams.selectedOptionTo,
				inputAmount: actionParams.amount.raw,
				isDepositing: isDepositing
			};

			const isValidSolver = ({
				quote,
				solver
			}: {
				quote: PromiseSettledResult<TNormalizedBN>;
				solver: TSolver;
			}): boolean => {
				return quote.status === 'fulfilled' && quote?.value.raw > 0n && !isSolverDisabled(solver);
			};

			switch (currentSolver) {
				case Solver.enum.Portals:
				case Solver.enum.Cowswap: {
					const [cowswapQuote, portalsQuote] = await Promise.allSettled([
						cowswap.init(request, currentSolver === Solver.enum.Cowswap),
						portals.init(request, currentSolver === Solver.enum.Portals)
					]);

					const solvers: {
						[key in TSolver]?: {
							quote: PromiseSettledResult<TNormalizedBN>;
							ctx: TSolverContext;
						};
					} = {};

					[
						{
							solver: Solver.enum.Cowswap,
							quote: cowswapQuote,
							ctx: cowswap
						},
						{
							solver: Solver.enum.Portals,
							quote: portalsQuote,
							ctx: portals
						}
					].forEach(({solver, quote, ctx}): void => {
						if (isValidSolver({quote, solver})) {
							solvers[solver] = {quote, ctx};
						}
					});

					solvers[Solver.enum.None] = {
						quote: {status: 'fulfilled', value: toNormalizedBN(0)},
						ctx: vanilla
					};

					const solverPriority = [Solver.enum.Cowswap, Solver.enum.Portals, Solver.enum.None];
					const newSolverPriority = [
						currentSolver,
						...solverPriority.filter((solver): boolean => solver !== currentSolver)
					];

					for (const solver of newSolverPriority) {
						if (!solvers[solver]) {
							continue;
						}

						const result = solvers[solver] ?? solvers[Solver.enum.None];
						if (result) {
							const {quote, ctx} = result;
							await handleUpdateSolver({
								currentNonce,
								request,
								quote,
								solver,
								ctx
							});
						}
						return;
					}
					break;
				}
				case Solver.enum.OptimismBooster: {
					const [quote] = await Promise.allSettled([optimismBooster.init(request)]);
					await handleUpdateSolver({
						currentNonce,
						request,
						quote,
						solver: Solver.enum.OptimismBooster,
						ctx: optimismBooster
					});
					break;
				}
				case Solver.enum.ChainCoin: {
					const [quote] = await Promise.allSettled([chainCoin.init(request)]);
					await handleUpdateSolver({
						currentNonce,
						request,
						quote,
						solver: Solver.enum.ChainCoin,
						ctx: chainCoin
					});
					break;
				}
				case Solver.enum.PartnerContract: {
					const [quote] = await Promise.allSettled([partnerContract.init(request)]);
					await handleUpdateSolver({
						currentNonce,
						request,
						quote,
						solver: Solver.enum.PartnerContract,
						ctx: partnerContract
					});
					break;
				}
				case Solver.enum.InternalMigration: {
					request.migrator = currentVault.migration.contract;
					const [quote] = await Promise.allSettled([internalMigration.init(request)]);
					await handleUpdateSolver({
						currentNonce,
						request,
						quote,
						solver: Solver.enum.InternalMigration,
						ctx: internalMigration
					});
					break;
				}
				default: {
					const [quote] = await Promise.allSettled([vanilla.init(request)]);
					await handleUpdateSolver({
						currentNonce,
						request,
						quote,
						solver: Solver.enum.Vanilla,
						ctx: vanilla
					});
				}
			}
		},
		[
			actionParams.selectedOptionFrom,
			actionParams.selectedOptionTo,
			actionParams.amount.raw,
			currentVault.chainID,
			currentVault.version,
			currentVault.migration.contract,
			address,
			isDepositing,
			currentSolver,
			cowswap,
			portals,
			vanilla,
			handleUpdateSolver,
			optimismBooster,
			chainCoin,
			partnerContract,
			internalMigration
		]
	);

	useEffect((): void => {
		const currentNonce = ++executionNonce.current;
		onUpdateSolver(currentNonce);
	}, [onUpdateSolver]);

	const contextValue = useMemo(
		(): TWithSolver => ({
			currentSolver: currentSolver,
			effectiveSolver: currentSolverState?.type,
			expectedOut: currentSolverState?.quote || toNormalizedBN(0),
			hash: currentSolverState?.hash,
			isLoadingExpectedOut: isLoading,
			onRetrieveAllowance: currentSolverState.onRetrieveAllowance,
			onApprove: currentSolverState.onApprove,
			onExecuteDeposit: currentSolverState.onExecuteDeposit,
			onExecuteWithdraw: currentSolverState.onExecuteWithdraw
		}),
		[currentSolver, currentSolverState, isLoading]
	);

	return <WithSolverContext.Provider value={contextValue}>{children}</WithSolverContext.Provider>;
}

export const useSolver = (): TWithSolver => useContext(WithSolverContext);
