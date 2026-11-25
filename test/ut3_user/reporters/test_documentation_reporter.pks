create or replace package test_documentation_reporter as

  --%suite(ut_documentation_reporter)
  --%suitepath(utplsql.test_user.reporters)

  --%test(Report produces expected output)
  procedure report_produces_expected_out;

  --%context(long texts)

    --%beforeall(create_long_texts_suite)
    --%afterall(drop_long_texts_suite)

    --%test(Reports a test whose description has nearly 4000 characters)
    procedure report_long_description;

    --%test(Reports a failing test whose description has nearly 4000 characters)
    procedure report_long_failing_description;

    --%test(Reports a disabled test with a reason of nearly 4000 characters)
    procedure report_long_disabled_reason;

  --%endcontext

  procedure create_long_texts_suite;
  procedure drop_long_texts_suite;

end;
/
