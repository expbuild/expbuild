package exe

import (
	"fmt"

	pb "github.com/expbuild/expbuild/pkg/proto/gen/remote_execution"
	"github.com/expbuild/expbuild/pkg/util/log"
	"github.com/google/uuid"
	longrunning "google.golang.org/genproto/googleapis/longrunning"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/anypb"
)

type ExeServer struct {
	pb.UnimplementedExecutionServer
	Amqp      string
	scheduler *Scheduler
}

func MakeExeServer() (*ExeServer, error) {
	scheduler, err := MakeScheduler()
	if err != nil {
		return nil, err
	}
	return &ExeServer{scheduler: scheduler}, nil
}

func (s *ExeServer) Start() {
	go func() {
		s.scheduler.queue.StartConsume()
	}()
}

func (s *ExeServer) Execute(req *pb.ExecuteRequest, stream pb.Execution_ExecuteServer) error {
	log.Debugf("recived execute request %v", req.ActionDigest)
	job := pb.Job{
		Id:     uuid.NewString(),
		Action: req.ActionDigest,
	}
	s.scheduler.Dispatch(&job)

	err := s.scheduler.Wait(job.Id)
	defer s.scheduler.DeleteJob(job.Id)
	//TODO result
	if err != nil {
		log.Errorf("wait job error %v", err)
		var eac pb.ActionResult
		eac.ExitCode = 1
		return s.sendResult(stream, &eac, job.Id)
	}

	ac, err := s.scheduler.GetJobActionResult(job.Id)
	if err != nil {
		log.Errorf("get job result error %v", err)
		var eac pb.ActionResult
		eac.ExitCode = 1
		return s.sendResult(stream, &eac, job.Id)
	}

	return s.sendResult(stream, ac, job.Id)
	//return status.Errorf(codes.Unimplemented, "method Execute not implemented")
}

func (s *ExeServer) sendResult(stream pb.Execution_ExecuteServer, ar *pb.ActionResult, jobid string) error {
	execResp := &pb.ExecuteResponse{
		Result:       ar,
		CachedResult: false,
	}
	any, err := anypb.New(execResp)
	if err != nil {
		return fmt.Errorf("recived a wrong job result")
	}
	operation := &longrunning.Operation{
		Name: jobid,
		Done: true,
		Result: &longrunning.Operation_Response{
			Response: any,
		},
	}
	return stream.Send(operation)
}

func (s *ExeServer) WaitExecution(req *pb.WaitExecutionRequest, stream pb.Execution_WaitExecutionServer) error {
	return status.Errorf(codes.Unimplemented, "method WaitExecution not implemented")
}
