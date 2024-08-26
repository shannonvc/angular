/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {absoluteFromSourceFile, NgtscProgram} from '@angular/compiler-cli';
import {TypeScriptReflectionHost} from '../../../../compiler-cli/src/ngtsc/reflection';
import ts from 'typescript';
import {
  confirmAsSerializable,
  ProgramInfo,
  Replacement,
  Serializable,
  TextUpdate,
  TsurgeComplexMigration,
} from '../../utils/tsurge';
import {ClassPropertyID, extractSourceQueryDefinition} from './identify_queries';
import {getReferenceTargetId} from './reference_tracking';
import {traverseAccess} from '../signal-migration/src/utils/traverse_access';
import {unwrapParent} from '../signal-migration/src/utils/unwrap_parent';
import {writeBinaryOperators} from '../signal-migration/src/utils/write_operators';
import {computeReplacementsToMigrateQuery} from './convert_query_property';
import {ImportManager, PartialEvaluator} from '../../../../compiler-cli/private/migrations';

export interface CompilationUnitData {
  knownQueryFields: Record<ClassPropertyID, true>;
  problematicQueries: Record<ClassPropertyID, true>;
}

export class SignalQueriesMigration extends TsurgeComplexMigration<
  CompilationUnitData,
  CompilationUnitData
> {
  override async analyze({
    sourceFiles,
    program,
    projectDirAbsPath,
  }: ProgramInfo<NgtscProgram>): Promise<Serializable<CompilationUnitData>> {
    // TODO: This stage for this migration doesn't necessarily need a full
    // compilation unit program.

    const tsProgram = program.getTsProgram();
    const checker = tsProgram.getTypeChecker();
    const reflector = new TypeScriptReflectionHost(checker);
    const evaluator = new PartialEvaluator(reflector, checker, null);
    const res: CompilationUnitData = {knownQueryFields: {}, problematicQueries: {}};

    const visitor = (node: ts.Node) => {
      const extractedQuery = extractSourceQueryDefinition(
        node,
        reflector,
        evaluator,
        projectDirAbsPath,
      );
      if (extractedQuery !== null) {
        res.knownQueryFields[extractedQuery.id] = true;
        return;
      }

      // Eager, rather expensive tracking of all potentially problematic writes.
      // We don't know yet if something refers to a different query or not, so we
      // eagerly detect such and later filter those problematic references that
      // turned out to refer to queries.
      // TODO: Skip this when running in non-batch mode.
      if (ts.isIdentifier(node) && !ts.isPropertyDeclaration(node.parent)) {
        const accessParent = unwrapParent(traverseAccess(node).parent);
        const isWriteReference =
          ts.isBinaryExpression(accessParent) &&
          writeBinaryOperators.includes(accessParent.operatorToken.kind);

        if (isWriteReference) {
          const targetId = getReferenceTargetId(node, checker, projectDirAbsPath);
          if (targetId !== null) {
            res.problematicQueries[targetId] = true;
          }
        }
      }

      ts.forEachChild(node, visitor);
    };
    for (const sf of sourceFiles) {
      ts.forEachChild(sf, visitor);
    }

    return confirmAsSerializable(res);
  }

  override async merge(units: CompilationUnitData[]): Promise<Serializable<CompilationUnitData>> {
    const merged: CompilationUnitData = {knownQueryFields: {}, problematicQueries: {}};
    for (const unit of units) {
      for (const id of Object.keys(unit.knownQueryFields)) {
        merged.knownQueryFields[id as ClassPropertyID] = true;
      }
      for (const id of Object.keys(unit.problematicQueries)) {
        merged.problematicQueries[id as ClassPropertyID] = true;
      }
    }
    return confirmAsSerializable(merged);
  }

  override async migrate(
    globalMetadata: CompilationUnitData,
    {program, projectDirAbsPath, sourceFiles}: ProgramInfo<NgtscProgram>,
  ): Promise<Replacement[]> {
    const tsProgram = program.getTsProgram();
    const checker = tsProgram.getTypeChecker();
    const reflector = new TypeScriptReflectionHost(checker);
    const evaluator = new PartialEvaluator(reflector, checker, null);
    const replacements: Replacement[] = [];
    const importManager = new ImportManager();

    const isMigratedQuery = (id: ClassPropertyID) =>
      globalMetadata.knownQueryFields[id] !== undefined &&
      globalMetadata.problematicQueries[id] === undefined;

    const visitor = (node: ts.Node) => {
      // Detect source queries and migrate them, if possible.
      const extractedQuery = extractSourceQueryDefinition(
        node,
        reflector,
        evaluator,
        projectDirAbsPath,
      );
      if (extractedQuery !== null && isMigratedQuery(extractedQuery.id)) {
        replacements.push(
          ...computeReplacementsToMigrateQuery(
            node as ts.PropertyDeclaration,
            extractedQuery,
            importManager,
          ),
        );
      }

      // Migrate references to queries, if those are migrated too.
      if (ts.isIdentifier(node) && !ts.isPropertyDeclaration(node.parent)) {
        const targetId = getReferenceTargetId(node, checker, projectDirAbsPath);
        if (targetId !== null && isMigratedQuery(targetId)) {
          replacements.push(
            new Replacement(
              absoluteFromSourceFile(node.getSourceFile()),
              new TextUpdate({position: node.getEnd(), end: node.getEnd(), toInsert: '()'}),
            ),
          );
        }
      }

      ts.forEachChild(node, visitor);
    };
    for (const sf of sourceFiles) {
      ts.forEachChild(sf, visitor);
    }

    return replacements;
  }
}