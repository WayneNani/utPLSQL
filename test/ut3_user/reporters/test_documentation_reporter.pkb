create or replace package body test_documentation_reporter as

  procedure report_produces_expected_out is
    l_results   ut3_develop.ut_varchar2_list;
    l_actual    clob;
    l_expected  varchar2(32767):=q'[%org
  utplsql
    tests
      helpers
        A suite for testing different outcomes from reporters
          <!beforeall!>
          A description of some context
            passing_test [% sec]
            <!beforeeach!>
            <!beforetest!>
            <!passing test!>
            <!aftertest!>
            <!aftereach!>
          a test with failing assertion [% sec] (FAILED - 1)
          <!beforeeach!>
          <!failing test!>
          <!aftereach!>
          a test raising unhandled exception [% sec] (FAILED - 2)
          <!beforeeach!>
          <!erroring test!>
          <!aftereach!>
          a disabled test [0 sec] (DISABLED - Disabled for testing purpose)
          a disabled test with no reason [0 sec] (DISABLED)
          <!afterall!>
%
Failures:
%
  1) failing_test
      "Fails as values are different"
      Actual: 'number [1] ' (varchar2) was expected to equal: 'number [2] ' (varchar2)%
      at "UT3_USER.TEST_REPORTERS%", line 36 ut3_develop.ut.expect('number [1] ','Fails as values are different').to_equal('number [2] ');
%
  2) erroring_test
      ORA-06502: PL/SQL: %: character to number conversion error
      ORA-06512: at "UT3_USER.TEST_REPORTERS", line 44%
      ORA-06512: at line 7
Finished in % seconds
5 tests, 1 failed, 1 errored, 2 disabled, 0 warning(s)%]';

  begin
    select *
    bulk collect into l_results
    from table(
      ut3_develop.ut.run(
          'test_reporters',
          ut3_develop.ut_documentation_reporter()
      )
    );
    l_actual := ut3_tester_helper.main_helper.table_to_clob(l_results);
    ut.expect(l_actual).to_be_like(l_expected);  
  end;

  procedure create_long_texts_suite is
    pragma autonomous_transaction;
  begin
    -- annotation lines start in the first column: a source line can't be longer than 4000 characters
    execute immediate
      'create or replace package test_long_texts as' || chr(10) ||
      '--%suite(Long texts)' || chr(10) || chr(10) ||
      '--%test(' || rpad('a', 3990, 'a') || ')' || chr(10) ||
      'procedure long_description;' || chr(10) ||
      '--%test(' || rpad('f', 3990, 'f') || ')' || chr(10) ||
      'procedure long_failing_description;' || chr(10) ||
      '--%test(Disabled)' || chr(10) ||
      '--%disabled(' || rpad('d', 3986, 'd') || ')' || chr(10) ||
      'procedure long_disabled_reason;' || chr(10) ||
      'end;';
    execute immediate
      'create or replace package body test_long_texts as
         procedure long_description is
         begin
           ut3_develop.ut.expect(1).to_equal(1);
         end;
         procedure long_failing_description is
         begin
           ut3_develop.ut.expect(1).to_equal(2);
         end;
         procedure long_disabled_reason is
         begin
           null;
         end;
       end;';
  end;

  procedure drop_long_texts_suite is
    pragma autonomous_transaction;
  begin
    execute immediate 'drop package test_long_texts';
  end;

  function run_long_texts(a_path varchar2) return clob is
    l_results ut3_develop.ut_varchar2_list;
  begin
    select *
      bulk collect into l_results
      from table(ut3_develop.ut.run(a_path, ut3_develop.ut_documentation_reporter()));
    return ut3_tester_helper.main_helper.table_to_clob(l_results);
  end;

  procedure report_long_description is
  begin
    ut.expect(run_long_texts('test_long_texts.long_description')).to_be_like(
      -- the line is longer than 4000 characters, so the output buffer splits it, within the execution time
      '%' || rpad('a', 3900, 'a') || '%[%1 tests, 0 failed, 0 errored, 0 disabled, 0 warning(s)%'
    );
  end;

  procedure report_long_failing_description is
  begin
    ut.expect(run_long_texts('test_long_texts.long_failing_description')).to_be_like(
      '%' || rpad('f', 3900, 'f') || '%[%(FAILED - 1)%1 tests, 1 failed, 0 errored, 0 disabled, 0 warning(s)%'
    );
  end;

  procedure report_long_disabled_reason is
  begin
    ut.expect(run_long_texts('test_long_texts.long_disabled_reason')).to_be_like(
      -- the line is longer than 4000 characters, so the output buffer splits it
      '%Disabled [0 sec] (DISABLED - ' || rpad('d', 3900, 'd') || '%1 tests, 0 failed, 0 errored, 1 disabled, 0 warning(s)%'
    );
  end;

end;
/
